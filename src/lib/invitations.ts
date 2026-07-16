import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  createAuditCorrelationId,
  recordAuditEvent,
} from "@/lib/audit-events";
import {
  assertRecentAuthentication,
  isActiveUserState,
} from "@/lib/security-policy";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";

const MAX_INVITATION_ATTEMPTS = 3;
const DEFAULT_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_INVITATION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const invitationEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());

export interface ProvisionInvitationInput {
  actorUserId: string;
  email: string;
  expiresAt?: Date;
  now?: Date;
  correlationId?: string;
}

export interface RevokeInvitationInput {
  actorUserId: string;
  email: string;
  now?: Date;
  correlationId?: string;
}

interface NormalizedProvisionInvitationInput {
  actorUserId: string;
  canonicalEmail: string;
  expiresAt: Date;
  now: Date;
  correlationId: string;
}

interface NormalizedRevokeInvitationInput {
  actorUserId: string;
  canonicalEmail: string;
  now: Date;
  correlationId: string;
}

export type ProvisionInvitationResult =
  | {
      status: "created" | "reissued" | "unchanged";
      invitationId: string;
      expiresAt: Date;
    }
  | {
      status: "already_active";
      invitationId: null;
      expiresAt: null;
    };

export type RevokeInvitationResult =
  | {
      status: "revoked";
      invitationId: string;
    }
  | {
      status: "unchanged";
      invitationId: string | null;
    };

export interface InvitationRepository {
  provision(
    input: NormalizedProvisionInvitationInput,
  ): Promise<ProvisionInvitationResult>;
  revoke(input: NormalizedRevokeInvitationInput): Promise<RevokeInvitationResult>;
  admit(
    canonicalEmail: string,
    now: Date,
    correlationId: string,
  ): Promise<boolean>;
}

export class InvitationValidationError extends Error {
  constructor() {
    super("The invitation request is invalid.");
    this.name = "InvitationValidationError";
  }
}

export class InvitationOperationNotPermittedError extends Error {
  constructor() {
    super("The invitation operation is not permitted.");
    this.name = "InvitationOperationNotPermittedError";
  }
}

export class InvitationConflictError extends Error {
  constructor() {
    super("The invitation operation conflicted with another database write.");
    this.name = "InvitationConflictError";
  }
}

function canonicalizeInvitationEmail(value: string) {
  const parsed = invitationEmailSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvitationValidationError();
  }

  return parsed.data;
}

function assertValidDate(value: Date) {
  if (Number.isNaN(value.getTime())) {
    throw new InvitationValidationError();
  }
}

function normalizeProvisionInput(
  input: ProvisionInvitationInput,
): NormalizedProvisionInvitationInput {
  const now = input.now ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + DEFAULT_INVITATION_LIFETIME_MS);

  assertValidDate(now);
  assertValidDate(expiresAt);

  const lifetime = expiresAt.getTime() - now.getTime();

  if (
    lifetime < MIN_INVITATION_LIFETIME_MS ||
    lifetime > MAX_INVITATION_LIFETIME_MS
  ) {
    throw new InvitationValidationError();
  }

  if (!input.actorUserId || input.actorUserId.length > 191) {
    throw new InvitationValidationError();
  }

  return {
    actorUserId: input.actorUserId,
    canonicalEmail: canonicalizeInvitationEmail(input.email),
    expiresAt,
    now,
    correlationId: input.correlationId ?? createAuditCorrelationId(),
  };
}

function normalizeRevokeInput(
  input: RevokeInvitationInput,
): NormalizedRevokeInvitationInput {
  const now = input.now ?? new Date();
  assertValidDate(now);

  if (!input.actorUserId || input.actorUserId.length > 191) {
    throw new InvitationValidationError();
  }

  return {
    actorUserId: input.actorUserId,
    canonicalEmail: canonicalizeInvitationEmail(input.email),
    now,
    correlationId: input.correlationId ?? createAuditCorrelationId(),
  };
}

export async function provisionInvitation(
  repository: InvitationRepository,
  input: ProvisionInvitationInput,
) {
  return repository.provision(normalizeProvisionInput(input));
}

export async function revokeInvitation(
  repository: InvitationRepository,
  input: RevokeInvitationInput,
) {
  return repository.revoke(normalizeRevokeInput(input));
}

export async function admitInvitedGoogleIdentity(
  repository: InvitationRepository,
  email: string,
  now = new Date(),
  correlationId = createAuditCorrelationId(),
) {
  const parsed = invitationEmailSchema.safeParse(email);

  if (!parsed.success || Number.isNaN(now.getTime())) {
    return false;
  }

  return repository.admit(parsed.data, now, correlationId);
}

type InvitationDatabase = Pick<PrismaClient, "$transaction">;

function actorSnapshotName(name: string | null) {
  const normalized = name?.trim();
  return normalized ? normalized.slice(0, 160) : "Administrator";
}

async function requireActiveAdministrator(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  now: Date,
) {
  const actor = await tx.user.findUnique({
    where: {
      id: actorUserId,
    },
    select: {
      id: true,
      name: true,
      role: true,
      status: true,
      lastAuthenticatedAt: true,
      disabledAt: true,
      deletedAt: true,
    },
  });

  if (!actor || actor.role !== "ADMIN" || !isActiveUserState(actor)) {
    throw new InvitationOperationNotPermittedError();
  }

  assertRecentAuthentication(actor.lastAuthenticatedAt, now);
  return actor;
}

async function runSerializable<T>(
  database: InvitationDatabase,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < MAX_INVITATION_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        hasPrismaErrorCode(error, "P2002") ||
        hasPrismaErrorCode(error, "P2034")
      ) {
        if (attempt === MAX_INVITATION_ATTEMPTS - 1) {
          throw new InvitationConflictError();
        }

        continue;
      }

      throw error;
    }
  }

  throw new InvitationConflictError();
}

export function createPrismaInvitationRepository(
  database: InvitationDatabase,
): InvitationRepository {
  return {
    async provision(input) {
      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          input.now,
        );
        const matchingUsers = await tx.user.findMany({
          where: {
            email: {
              equals: input.canonicalEmail,
              mode: "insensitive",
            },
          },
          select: {
            id: true,
            email: true,
            status: true,
            disabledAt: true,
            deletedAt: true,
          },
          take: 2,
        });

        if (matchingUsers.length > 1) {
          throw new InvitationOperationNotPermittedError();
        }

        const matchingUser = matchingUsers[0];

        if (matchingUser && isActiveUserState(matchingUser)) {
          await recordAuditEvent(tx, {
            action: "invitation.provision_skipped",
            actorUserId: actor.id,
            actorIdSnapshot: actor.id,
            actorNameSnapshot: actorSnapshotName(actor.name),
            targetType: "user",
            targetIdSnapshot: matchingUser.id,
            correlationId: input.correlationId,
            metadata: {
              outcome: "already_active",
            },
            createdAt: input.now,
          });

          return {
            status: "already_active",
            invitationId: null,
            expiresAt: null,
          };
        }

        if (matchingUser && matchingUser.status !== "PENDING") {
          throw new InvitationOperationNotPermittedError();
        }

        const provisionedUser = matchingUser
          ? matchingUser.email === input.canonicalEmail
            ? matchingUser
            : await tx.user.update({
                where: {
                  id: matchingUser.id,
                },
                data: {
                  email: input.canonicalEmail,
                },
                select: {
                  id: true,
                  email: true,
                  status: true,
                  disabledAt: true,
                  deletedAt: true,
                },
              })
          : await tx.user.create({
              data: {
                email: input.canonicalEmail,
                status: "PENDING",
              },
              select: {
                id: true,
                email: true,
                status: true,
                disabledAt: true,
                deletedAt: true,
              },
            });

        const existingInvitation = await tx.invitation.findUnique({
          where: {
            email: input.canonicalEmail,
          },
          select: {
            id: true,
            status: true,
            expiresAt: true,
            provisionedUserId: true,
          },
        });

        if (
          existingInvitation?.provisionedUserId &&
          existingInvitation.provisionedUserId !== provisionedUser.id
        ) {
          throw new InvitationOperationNotPermittedError();
        }

        const remainsUsable =
          existingInvitation?.status === "PENDING" &&
          existingInvitation.expiresAt.getTime() > input.now.getTime();
        let outcome: "created" | "reissued" | "unchanged";
        let invitation: { id: string; expiresAt: Date };

        if (existingInvitation && remainsUsable) {
          outcome = "unchanged";
          invitation = existingInvitation;
         } else if (existingInvitation) {
           outcome = "reissued";
           invitation = await tx.invitation.update({
            where: {
              id: existingInvitation.id,
            },
             data: {
               status: "PENDING",
               createdAt: input.now,
               expiresAt: input.expiresAt,
              acceptedAt: null,
              revokedAt: null,
              invitedById: actor.id,
              provisionedUserId: provisionedUser.id,
            },
            select: {
              id: true,
              expiresAt: true,
            },
          });
        } else {
          outcome = "created";
          invitation = await tx.invitation.create({
             data: {
               email: input.canonicalEmail,
               status: "PENDING",
               createdAt: input.now,
               expiresAt: input.expiresAt,
              invitedById: actor.id,
              provisionedUserId: provisionedUser.id,
            },
            select: {
              id: true,
              expiresAt: true,
            },
          });
        }

        await recordAuditEvent(tx, {
          action: `invitation.${outcome}`,
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "invitation",
          targetIdSnapshot: invitation.id,
          correlationId: input.correlationId,
          metadata: {
            outcome,
          },
          createdAt: input.now,
        });

        return {
          status: outcome,
          invitationId: invitation.id,
          expiresAt: invitation.expiresAt,
        };
      });
    },

    async revoke(input) {
      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          input.now,
        );
        const invitation = await tx.invitation.findUnique({
          where: {
            email: input.canonicalEmail,
          },
          select: {
            id: true,
            status: true,
          },
        });

        if (!invitation || invitation.status !== "PENDING") {
          return {
            status: "unchanged",
            invitationId: invitation?.id ?? null,
          };
        }

        const revoked = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            status: "PENDING",
          },
          data: {
            status: "REVOKED",
            revokedAt: input.now,
          },
        });

        if (revoked.count !== 1) {
          throw new InvitationConflictError();
        }

        await recordAuditEvent(tx, {
          action: "invitation.revoked",
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "invitation",
          targetIdSnapshot: invitation.id,
          correlationId: input.correlationId,
          metadata: {
            outcome: "revoked",
          },
          createdAt: input.now,
        });

        return {
          status: "revoked",
          invitationId: invitation.id,
        };
      });
    },

    async admit(canonicalEmail, now, correlationId) {
      return runSerializable(database, async (tx) => {
        const matchingUsers = await tx.user.findMany({
          where: {
            email: {
              equals: canonicalEmail,
              mode: "insensitive",
            },
          },
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
            disabledAt: true,
            deletedAt: true,
          },
          take: 2,
        });

        if (matchingUsers.length !== 1) {
          return false;
        }

        const user = matchingUsers[0];

        if (isActiveUserState(user)) {
          if (user.email !== canonicalEmail) {
            await tx.user.update({
              where: {
                id: user.id,
              },
              data: {
                email: canonicalEmail,
              },
            });
          }

          // Recent authentication is account-scoped, so a verified new login
          // must invalidate every older database session before Auth.js creates
          // the replacement session. An old/stolen session therefore cannot
          // inherit a fresh authentication performed on another device.
          await tx.session.deleteMany({
            where: {
              userId: user.id,
            },
          });

          return true;
        }

        if (
          user.status !== "PENDING" ||
          user.disabledAt !== null ||
          user.deletedAt !== null
        ) {
          return false;
        }

        const invitation = await tx.invitation.findUnique({
          where: {
            email: canonicalEmail,
          },
          select: {
            id: true,
            status: true,
            expiresAt: true,
            provisionedUserId: true,
          },
        });

        if (
          !invitation ||
          invitation.status !== "PENDING" ||
          invitation.provisionedUserId !== user.id ||
          invitation.expiresAt.getTime() <= now.getTime()
        ) {
          return false;
        }

        const accepted = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            status: "PENDING",
            acceptedAt: null,
            expiresAt: {
              gt: now,
            },
            provisionedUserId: user.id,
          },
          data: {
            status: "ACCEPTED",
            acceptedAt: now,
          },
        });

        if (accepted.count !== 1) {
          throw new InvitationConflictError();
        }

        const activated = await tx.user.updateMany({
          where: {
            id: user.id,
            status: "PENDING",
            disabledAt: null,
            deletedAt: null,
          },
          data: {
            email: canonicalEmail,
            status: "ACTIVE",
          },
        });

        if (activated.count !== 1) {
          throw new InvitationConflictError();
        }

        await tx.session.deleteMany({
          where: {
            userId: user.id,
          },
        });

        await recordAuditEvent(tx, {
          action: "invitation.accepted",
          actorUserId: user.id,
          actorIdSnapshot: user.id,
          actorNameSnapshot: user.name?.trim().slice(0, 160) || "Invited user",
          targetType: "invitation",
          targetIdSnapshot: invitation.id,
          correlationId,
          metadata: {
            outcome: "accepted",
          },
          createdAt: now,
        });

        return true;
      });
    },
  };
}
