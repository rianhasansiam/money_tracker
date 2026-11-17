import type {
  InvitationStatus,
  Prisma,
  PrismaClient,
  TeamMemberRole,
  TeamMembershipStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import {
  createAuditCorrelationId,
  recordAuditEvent,
} from "@/lib/audit-events";
import { db } from "@/lib/db";
import { ADMIN_VIEWS, type AdminView } from "@/lib/admin-navigation";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import {
  RecentAuthenticationRequiredError,
  assertRecentAuthentication,
  isActiveUserState,
} from "@/lib/security-policy";
import { UserLifecycleConflictError } from "@/lib/user-lifecycle";
import {
  globalRoleInputSchema,
  membershipRevocationInputSchema,
  ownershipTransferInputSchema,
  userLifecycleInputSchema,
} from "@/lib/validators/admin";
import {
  collectionCursorSchema,
  emailCursorSchema,
} from "@/lib/validators/pagination";

const SERIALIZABLE_ATTEMPTS = 3;
export const ADMIN_USER_LIMIT = 25;
export const ADMIN_INVITATION_LIMIT = 25;
export const ADMIN_TEAM_LIMIT = 20;
export const ADMIN_TEAM_MEMBER_LIMIT = 25;

type AdminDatabase = Pick<PrismaClient, "$transaction">;

export interface AdminConsoleUserDto {
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  ownedTeamCount: number;
}

export interface AdminConsoleInvitationDto {
  email: string;
  status: InvitationStatus;
  expiresAt: string;
}

export interface AdminConsoleTeamMemberDto {
  email: string;
  name: string;
  role: TeamMemberRole;
  status: TeamMembershipStatus;
}

interface AdminMemberProjection {
  role: TeamMemberRole;
  status: TeamMembershipStatus;
  user: { name: string | null; email: string | null };
}

export interface AdminConsoleTeamDto {
  teamId: string;
  name: string;
  ownerEmail: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  members: AdminConsoleTeamMemberDto[];
  membersTruncated: boolean;
  nextMemberCursor: string | null;
  recoveryEligibility?: "eligible" | "expired" | "active";
}

export interface AdminConsoleDto {
  viewerName: string;
  users: AdminConsoleUserDto[];
  invitations: AdminConsoleInvitationDto[];
  teams: AdminConsoleTeamDto[];
  truncated: {
    users: boolean;
    invitations: boolean;
    teams: boolean;
  };
  nextCursors: {
    users: string | null;
    invitations: string | null;
    teams: string | null;
  };
}

export interface AdminConsoleCursors {
  users?: string;
  invitations?: string;
  teams?: string;
  memberTeamId?: string;
  members?: string;
}

export type AdminMutationResult =
  | {
      status: "changed";
      revokedSessionCount: number;
    }
  | {
      status: "unchanged";
      revokedSessionCount: number;
    }
  | {
      status:
        | "confirmation_mismatch"
        | "last_admin_required"
        | "ownership_transfer_required"
        | "recent_authentication_required"
        | "unavailable";
    };

interface MutationContext {
  actorUserId: string;
  correlationId?: string;
  now?: Date;
}

export interface SetUserEnabledInput extends MutationContext {
  email: string;
  enabled: boolean;
}

export interface SetGlobalRoleInput extends MutationContext {
  email: string;
  role: UserRole;
}

export interface RevokeMembershipInput extends MutationContext {
  teamId: string;
  email: string;
}

export interface TransferOwnershipInput extends MutationContext {
  teamId: string;
  newOwnerEmail: string;
  confirmedTeamName: string;
}

export interface AdminWorkflowRepository {
  getConsoleData(
    actorUserId: string,
    searchQuery?: string,
    cursors?: AdminConsoleCursors,
    view?: AdminView,
  ): Promise<AdminConsoleDto | null>;
  setUserEnabled(input: SetUserEnabledInput): Promise<AdminMutationResult>;
  setGlobalRole(input: SetGlobalRoleInput): Promise<AdminMutationResult>;
  revokeMembership(
    input: RevokeMembershipInput,
  ): Promise<AdminMutationResult>;
  transferOwnership(
    input: TransferOwnershipInput,
  ): Promise<AdminMutationResult>;
}

interface ActiveAdministrator {
  id: string;
  name: string | null;
}

function hasSerializationFailure(error: unknown) {
  if (hasPrismaErrorCode(error, "P2034")) {
    return true;
  }

  if (!hasPrismaErrorCode(error, "P2010")) {
    return false;
  }

  try {
    return JSON.stringify(error).includes("40001");
  } catch {
    return false;
  }
}

function actorSnapshotName(name: string | null) {
  return name?.trim().slice(0, 160) || "Administrator";
}

function normalizeDate(now?: Date) {
  const value = now ?? new Date();

  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value;
}

async function requireActiveAdministrator(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  now: Date,
): Promise<ActiveAdministrator | "recent_authentication_required" | null> {
  if (!actorUserId || actorUserId.length > 191) {
    return null;
  }

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

  if (
    !actor ||
    actor.role !== "ADMIN" ||
    !isActiveUserState(actor)
  ) {
    return null;
  }

  try {
    assertRecentAuthentication(actor.lastAuthenticatedAt, now);
  } catch (error) {
    if (error instanceof RecentAuthenticationRequiredError) {
      return "recent_authentication_required";
    }

    throw error;
  }

  return {
    id: actor.id,
    name: actor.name,
  };
}

async function findExactlyOneUserByEmail(
  tx: Prisma.TransactionClient,
  email: string,
) {
  const users = await tx.user.findMany({
    where: {
      email: {
        equals: email,
        mode: "insensitive",
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      disabledAt: true,
      deletedAt: true,
      _count: {
        select: {
          createdTeams: true,
        },
      },
    },
    take: 2,
  });

  return users.length === 1 ? users[0] : null;
}

async function countActiveAdministrators(tx: Prisma.TransactionClient) {
  return tx.user.count({
    where: {
      role: "ADMIN",
      status: "ACTIVE",
      disabledAt: null,
      deletedAt: null,
    },
  });
}

async function runSerializable<T>(
  database: AdminDatabase,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (hasSerializationFailure(error)) {
        if (attempt === SERIALIZABLE_ATTEMPTS - 1) {
          throw new UserLifecycleConflictError();
        }

        continue;
      }

      throw error;
    }
  }

  throw new UserLifecycleConflictError();
}

function workflowContext(input: MutationContext) {
  const now = normalizeDate(input.now);

  if (!now) {
    return null;
  }

  return {
    now,
    correlationId: input.correlationId ?? createAuditCorrelationId(),
  };
}

function parseCollectionCursor(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = collectionCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseEmailCursor(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = emailCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function adminUserWhere(normalizedSearch: string | undefined): Prisma.UserWhereInput {
  return {
    email: {
      not: null,
    },
    deletedAt: null,
    status: {
      not: "DELETED",
    },
    ...(normalizedSearch
      ? {
          OR: [
            {
              email: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
            {
              name: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
          ],
        }
      : {}),
  };
}

function adminInvitationWhere(
  normalizedSearch: string | undefined,
): Prisma.InvitationWhereInput | undefined {
  return normalizedSearch
    ? {
        email: {
          contains: normalizedSearch,
          mode: "insensitive",
        },
      }
    : undefined;
}

function adminTeamWhere(normalizedSearch: string | undefined): Prisma.TeamWhereInput | undefined {
  return normalizedSearch
    ? {
        OR: [
          {
            name: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          },
          {
            createdBy: {
              email: {
                contains: normalizedSearch,
                mode: "insensitive",
              },
            },
          },
          {
            memberships: {
              some: {
                user: {
                  OR: [
                    {
                      email: {
                        contains: normalizedSearch,
                        mode: "insensitive",
                      },
                    },
                    {
                      name: {
                        contains: normalizedSearch,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      }
    : undefined;
}

function adminTeamMemberWhere(
  normalizedSearch: string | undefined,
  teamId?: string,
): Prisma.TeamMembershipWhereInput {
  return {
    ...(teamId ? { teamId } : {}),
    status: {
      in: ["APPROVED", "PENDING"],
    },
    user: {
      email: {
        not: null,
      },
      deletedAt: null,
      ...(normalizedSearch
        ? {
            OR: [
              {
                email: {
                  contains: normalizedSearch,
                  mode: "insensitive" as const,
                },
              },
              {
                name: {
                  contains: normalizedSearch,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
    },
  };
}

export function createPrismaAdminWorkflowRepository(
  database: AdminDatabase,
): AdminWorkflowRepository {
  return {
    async getConsoleData(actorUserId, searchQuery, cursors = {}, view) {
      if (!actorUserId || actorUserId.length > 191) {
        return null;
      }
      if (view !== undefined && !ADMIN_VIEWS.includes(view)) return null;
      const readUsers = view === undefined || view === "accounts";
      const readInvitations = view === undefined || view === "invitations";
      const readTeams = view === undefined || view === "access" || view === "recovery";
      const readMembers = view === undefined || view === "access";

      const normalizedSearch = searchQuery?.trim();

      if (normalizedSearch && normalizedSearch.length > 254) {
        return null;
      }

      const userCursor = parseEmailCursor(readUsers ? cursors.users : undefined);
      const invitationCursor = parseEmailCursor(readInvitations ? cursors.invitations : undefined);
      const teamCursor = parseCollectionCursor(readTeams ? cursors.teams : undefined);
      const memberTeamId = parseCollectionCursor(readMembers ? cursors.memberTeamId : undefined);
      const memberCursor = parseEmailCursor(readMembers ? cursors.members : undefined);

      if (
        userCursor === null ||
        invitationCursor === null ||
        teamCursor === null ||
        memberTeamId === null ||
        memberCursor === null ||
        Boolean(memberTeamId) !== Boolean(memberCursor)
      ) {
        return null;
      }

      return database.$transaction(
        async (tx) => {
          const actor = await tx.user.findFirst({
            where: {
              id: actorUserId,
              role: "ADMIN",
              status: "ACTIVE",
              disabledAt: null,
              deletedAt: null,
            },
            select: {
              name: true,
            },
          });

          if (!actor) {
            return null;
          }

          const userWhere = adminUserWhere(normalizedSearch);
          const invitationWhere = adminInvitationWhere(normalizedSearch);
          const teamWhere: Prisma.TeamWhereInput = {
            ...adminTeamWhere(normalizedSearch),
            ...(view === "access" ? { deletedAt: null } : {}),
            ...(view === "recovery" ? { deletedAt: { not: null } } : {}),
          };
          const memberWhere = adminTeamMemberWhere(
            normalizedSearch,
            memberTeamId,
          );
          const [
            authorizedUserCursor,
            authorizedInvitationCursor,
            authorizedTeamCursor,
            authorizedMemberCursor,
          ] = await Promise.all([
            userCursor
              ? tx.user.findFirst({
                  where: {
                    AND: [userWhere, { email: userCursor }],
                  },
                  select: { email: true },
                })
              : Promise.resolve(undefined),
            invitationCursor
              ? tx.invitation.findFirst({
                  where: {
                    AND: [invitationWhere ?? {}, { email: invitationCursor }],
                  },
                  select: { email: true },
                })
              : Promise.resolve(undefined),
            teamCursor
              ? tx.team.findFirst({
                  where: {
                    AND: [teamWhere ?? {}, { id: teamCursor }],
                  },
                  select: { id: true },
                })
              : Promise.resolve(undefined),
            memberCursor
              ? tx.teamMembership.findFirst({
                  where: {
                    AND: [memberWhere, { user: { email: memberCursor } }],
                  },
                  select: { id: true },
                })
              : Promise.resolve(undefined),
          ]);

          if (
            (userCursor && !authorizedUserCursor) ||
            (invitationCursor && !authorizedInvitationCursor) ||
            (teamCursor && !authorizedTeamCursor) ||
            (memberCursor && !authorizedMemberCursor)
          ) {
            return null;
          }

          const users = readUsers ? await tx.user.findMany({
            where: userWhere,
            orderBy: [{ email: "asc" }, { id: "asc" }],
            ...(authorizedUserCursor
              ? { cursor: { email: userCursor }, skip: 1 }
              : {}),
            take: ADMIN_USER_LIMIT + 1,
            select: {
              name: true,
              email: true,
              role: true,
              status: true,
              _count: {
                select: {
                  createdTeams: true,
                },
              },
            },
          }) : [];
          const invitations = readInvitations ? await tx.invitation.findMany({
            where: invitationWhere,
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            ...(authorizedInvitationCursor
              ? {
                  cursor: { email: invitationCursor },
                  skip: 1,
                }
              : {}),
            take: ADMIN_INVITATION_LIMIT + 1,
            select: {
              email: true,
              status: true,
              expiresAt: true,
            },
          }) : [];
          const teams = readTeams ? await tx.team.findMany({
            where: teamWhere,
            orderBy: [
              { deletedAt: { sort: "asc", nulls: "first" } },
              { name: "asc" },
              { id: "asc" },
            ],
            ...(authorizedTeamCursor
              ? { cursor: { id: authorizedTeamCursor.id }, skip: 1 }
              : {}),
            take: ADMIN_TEAM_LIMIT + 1,
            select: {
              id: true,
              name: true,
              deletedAt: true,
              purgeAfter: true,
              createdBy: {
                select: {
                  email: true,
                },
              },
              memberships: readMembers ? {
                where: adminTeamMemberWhere(normalizedSearch),
                orderBy: [{ user: { email: "asc" } }, { id: "asc" }],
                take: ADMIN_TEAM_MEMBER_LIMIT + 1,
                select: {
                  role: true,
                  status: true,
                  user: {
                    select: {
                      name: true,
                      email: true,
                    },
                  },
                },
              } : undefined,
            },
          }) : [];

          const pageTeams = teams.slice(0, ADMIN_TEAM_LIMIT);

          if (
            memberTeamId &&
            !pageTeams.some((team) => team.id === memberTeamId)
          ) {
            return null;
          }

          const selectedMemberRows =
            memberTeamId && memberCursor
              ? await tx.teamMembership.findMany({
                  where: {
                    AND: [
                      memberWhere,
                      {
                        user: {
                          email: {
                            gt: memberCursor,
                          },
                        },
                      },
                    ],
                  },
                  orderBy: [{ user: { email: "asc" } }, { id: "asc" }],
                  take: ADMIN_TEAM_MEMBER_LIMIT + 1,
                  select: {
                    role: true,
                    status: true,
                    user: {
                      select: {
                        name: true,
                        email: true,
                      },
                    },
                  },
                })
              : null;

          const userPage = users.slice(0, ADMIN_USER_LIMIT);
          const invitationPage = invitations.slice(0, ADMIN_INVITATION_LIMIT);

          return {
            viewerName: actorSnapshotName(actor.name),
            users: userPage.flatMap((user) =>
                user.email
                  ? [
                      {
                        email: user.email,
                        name: user.name?.trim().slice(0, 160) || "Unnamed user",
                        role: user.role,
                        status: user.status,
                        ownedTeamCount: user._count.createdTeams,
                      },
                    ]
                  : [],
              ),
            invitations: invitationPage.map((invitation) => ({
                email: invitation.email,
                status: invitation.status,
                expiresAt: invitation.expiresAt.toISOString(),
              })),
            teams: pageTeams.map((team) => {
              const membershipRows =
                team.id === memberTeamId && selectedMemberRows
                  ? selectedMemberRows
                  // Prisma widens an optional relation selection to the model
                  // type. The selected branch explicitly projects user below;
                  // recovery never requests or consumes these member rows.
                  : readMembers ? (team.memberships ?? []) as unknown as AdminMemberProjection[] : [];
              const membershipPage = membershipRows.slice(
                0,
                ADMIN_TEAM_MEMBER_LIMIT,
              );

              return {
                teamId: team.id,
                name: team.name,
                ownerEmail: team.createdBy.email,
                deletedAt: team.deletedAt?.toISOString() ?? null,
                purgeAfter: team.purgeAfter?.toISOString() ?? null,
                recoveryEligibility: !team.deletedAt
                  ? "active" as const
                  : team.purgeAfter && team.purgeAfter.getTime() > Date.now()
                    ? "eligible" as const : "expired" as const,
                members: membershipPage.flatMap((membership) =>
                  membership.user.email
                    ? [
                        {
                          email: membership.user.email,
                          name:
                            membership.user.name?.trim().slice(0, 160) ||
                            "Unnamed user",
                          role: membership.role,
                          status: membership.status,
                        },
                      ]
                    : [],
                ),
                membersTruncated:
                  membershipRows.length > ADMIN_TEAM_MEMBER_LIMIT,
                nextMemberCursor:
                  membershipRows.length > ADMIN_TEAM_MEMBER_LIMIT
                    ? membershipPage.at(-1)?.user.email ?? null
                    : null,
              };
            }),
            truncated: {
              users: users.length > ADMIN_USER_LIMIT,
              invitations: invitations.length > ADMIN_INVITATION_LIMIT,
              teams: teams.length > ADMIN_TEAM_LIMIT,
            },
            nextCursors: {
              users:
                users.length > ADMIN_USER_LIMIT
                  ? userPage.at(-1)?.email ?? null
                  : null,
              invitations:
                invitations.length > ADMIN_INVITATION_LIMIT
                  ? invitationPage.at(-1)?.email ?? null
                  : null,
              teams:
                teams.length > ADMIN_TEAM_LIMIT
                  ? pageTeams.at(-1)?.id ?? null
                  : null,
            },
          } satisfies AdminConsoleDto;
        },
        {
          isolationLevel: "RepeatableRead",
        },
      );
    },

    async setUserEnabled(input) {
      const parsedInput = userLifecycleInputSchema.safeParse({
        email: input.email,
      });
      const context = workflowContext(input);

      if (!parsedInput.success || !context) {
        return { status: "unavailable" };
      }

      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          context.now,
        );

        if (actor === "recent_authentication_required") {
          return { status: actor };
        }

        if (!actor) {
          return { status: "unavailable" };
        }

        const target = await findExactlyOneUserByEmail(
          tx,
          parsedInput.data.email,
        );

        if (!target || target.deletedAt || target.status === "DELETED") {
          return { status: "unavailable" };
        }

        if (input.enabled) {
          if (target.status === "ACTIVE" && target.disabledAt === null) {
            return { status: "unchanged", revokedSessionCount: 0 };
          }

          if (target.status !== "DISABLED") {
            return { status: "unavailable" };
          }

          const changed = await tx.user.updateMany({
            where: {
              id: target.id,
              status: "DISABLED",
              deletedAt: null,
            },
            data: {
              status: "ACTIVE",
              disabledAt: null,
            },
          });

          if (changed.count !== 1) {
            throw new UserLifecycleConflictError();
          }

          const sessions = await tx.session.deleteMany({
            where: {
              userId: target.id,
            },
          });

          await recordAuditEvent(tx, {
            action: "user.enabled",
            actorUserId: actor.id,
            actorIdSnapshot: actor.id,
            actorNameSnapshot: actorSnapshotName(actor.name),
            targetType: "user",
            targetIdSnapshot: target.id,
            correlationId: context.correlationId,
            metadata: {
              outcome: "enabled",
              revokedSessionCount: sessions.count,
            },
            createdAt: context.now,
          });

          return {
            status: "changed",
            revokedSessionCount: sessions.count,
          };
        }

        if (target.status === "DISABLED" && target.disabledAt !== null) {
          return { status: "unchanged", revokedSessionCount: 0 };
        }

        if (!isActiveUserState(target)) {
          return { status: "unavailable" };
        }

        if (target._count.createdTeams > 0) {
          return { status: "ownership_transfer_required" };
        }

        if (
          target.role === "ADMIN" &&
          (await countActiveAdministrators(tx)) <= 1
        ) {
          return { status: "last_admin_required" };
        }

        const changed = await tx.user.updateMany({
          where: {
            id: target.id,
            status: "ACTIVE",
            disabledAt: null,
            deletedAt: null,
          },
          data: {
            status: "DISABLED",
            disabledAt: context.now,
          },
        });

        if (changed.count !== 1) {
          throw new UserLifecycleConflictError();
        }

        const sessions = await tx.session.deleteMany({
          where: {
            userId: target.id,
          },
        });

        await recordAuditEvent(tx, {
          action: "user.disabled",
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "user",
          targetIdSnapshot: target.id,
          correlationId: context.correlationId,
          metadata: {
            outcome: "disabled",
            revokedSessionCount: sessions.count,
          },
          createdAt: context.now,
        });

        return {
          status: "changed",
          revokedSessionCount: sessions.count,
        };
      });
    },

    async setGlobalRole(input) {
      const parsedInput = globalRoleInputSchema.safeParse({
        email: input.email,
        role: input.role,
      });
      const context = workflowContext(input);

      if (!parsedInput.success || !context) {
        return { status: "unavailable" };
      }

      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          context.now,
        );

        if (actor === "recent_authentication_required") {
          return { status: actor };
        }

        if (!actor) {
          return { status: "unavailable" };
        }

        const target = await findExactlyOneUserByEmail(
          tx,
          parsedInput.data.email,
        );

        if (!target || !isActiveUserState(target)) {
          return { status: "unavailable" };
        }

        if (target.role === parsedInput.data.role) {
          return { status: "unchanged", revokedSessionCount: 0 };
        }

        if (
          target.role === "ADMIN" &&
          parsedInput.data.role !== "ADMIN"
        ) {
          if ((await countActiveAdministrators(tx)) <= 1) {
            return { status: "last_admin_required" };
          }
        }

        const changed = await tx.user.updateMany({
          where: {
            id: target.id,
            role: target.role,
            status: "ACTIVE",
            disabledAt: null,
            deletedAt: null,
          },
          data: {
            role: parsedInput.data.role,
          },
        });

        if (changed.count !== 1) {
          throw new UserLifecycleConflictError();
        }

        const sessions = await tx.session.deleteMany({
          where: {
            userId: target.id,
          },
        });

        await recordAuditEvent(tx, {
          action: "user.global_role_changed",
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "user",
          targetIdSnapshot: target.id,
          correlationId: context.correlationId,
          metadata: {
            fromRole: target.role,
            toRole: parsedInput.data.role,
            revokedSessionCount: sessions.count,
          },
          createdAt: context.now,
        });

        return {
          status: "changed",
          revokedSessionCount: sessions.count,
        };
      });
    },

    async revokeMembership(input) {
      const parsedInput = membershipRevocationInputSchema.safeParse({
        teamId: input.teamId,
        email: input.email,
      });
      const context = workflowContext(input);

      if (!parsedInput.success || !context) {
        return { status: "unavailable" };
      }

      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          context.now,
        );

        if (actor === "recent_authentication_required") {
          return { status: actor };
        }

        if (!actor) {
          return { status: "unavailable" };
        }

        const target = await findExactlyOneUserByEmail(
          tx,
          parsedInput.data.email,
        );
        const team = await tx.team.findFirst({
          where: {
            id: parsedInput.data.teamId,
            deletedAt: null,
          },
          select: {
            id: true,
            createdById: true,
          },
        });

        if (!target || !team) {
          return { status: "unavailable" };
        }

        if (team.createdById === target.id) {
          return { status: "ownership_transfer_required" };
        }

        const membership = await tx.teamMembership.findUnique({
          where: {
            teamId_userId: {
              teamId: team.id,
              userId: target.id,
            },
          },
          select: {
            id: true,
            status: true,
          },
        });

        if (!membership) {
          return { status: "unavailable" };
        }

        if (membership.status === "REVOKED") {
          return { status: "unchanged", revokedSessionCount: 0 };
        }

        const changed = await tx.teamMembership.updateMany({
          where: {
            id: membership.id,
            teamId: team.id,
            userId: target.id,
            status: membership.status,
          },
          data: {
            status: "REVOKED",
            approvedAt: null,
            approvedById: null,
          },
        });

        if (changed.count !== 1) {
          throw new UserLifecycleConflictError();
        }

        const sessions = await tx.session.deleteMany({
          where: {
            userId: target.id,
          },
        });

        await recordAuditEvent(tx, {
          action: "team.membership_revoked",
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "team_membership",
          targetIdSnapshot: membership.id,
          teamIdSnapshot: team.id,
          correlationId: context.correlationId,
          metadata: {
            previousStatus: membership.status,
            subjectIdSnapshot: target.id,
            revokedSessionCount: sessions.count,
          },
          createdAt: context.now,
        });

        return {
          status: "changed",
          revokedSessionCount: sessions.count,
        };
      });
    },

    async transferOwnership(input) {
      const parsedInput = ownershipTransferInputSchema.safeParse({
        teamId: input.teamId,
        newOwnerEmail: input.newOwnerEmail,
        confirmedTeamName: input.confirmedTeamName,
      });
      const context = workflowContext(input);

      if (!parsedInput.success || !context) {
        return { status: "unavailable" };
      }

      return runSerializable(database, async (tx) => {
        const actor = await requireActiveAdministrator(
          tx,
          input.actorUserId,
          context.now,
        );

        if (actor === "recent_authentication_required") {
          return { status: actor };
        }

        if (!actor) {
          return { status: "unavailable" };
        }

        const target = await findExactlyOneUserByEmail(
          tx,
          parsedInput.data.newOwnerEmail,
        );
        const team = await tx.team.findFirst({
          where: {
            id: parsedInput.data.teamId,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            createdById: true,
          },
        });

        if (!target || !isActiveUserState(target) || !team) {
          return { status: "unavailable" };
        }

        if (parsedInput.data.confirmedTeamName !== team.name) {
          return { status: "confirmation_mismatch" };
        }

        const targetMembership = await tx.teamMembership.findUnique({
          where: {
            teamId_userId: {
              teamId: team.id,
              userId: target.id,
            },
          },
          select: {
            id: true,
            role: true,
            status: true,
          },
        });

        if (!targetMembership || targetMembership.status !== "APPROVED") {
          return { status: "unavailable" };
        }

        if (team.createdById === target.id) {
          return { status: "unchanged", revokedSessionCount: 0 };
        }

        if (targetMembership.role !== "ADMIN") {
          const promoted = await tx.teamMembership.updateMany({
            where: {
              id: targetMembership.id,
              teamId: team.id,
              userId: target.id,
              status: "APPROVED",
            },
            data: {
              role: "ADMIN",
            },
          });

          if (promoted.count !== 1) {
            throw new UserLifecycleConflictError();
          }
        }

        const changed = await tx.team.updateMany({
          where: {
            id: team.id,
            createdById: team.createdById,
            deletedAt: null,
          },
          data: {
            createdById: target.id,
          },
        });

        if (changed.count !== 1) {
          throw new UserLifecycleConflictError();
        }

        const sessions = await tx.session.deleteMany({
          where: {
            userId: {
              in: [team.createdById, target.id],
            },
          },
        });

        await recordAuditEvent(tx, {
          action: "team.ownership_transferred",
          actorUserId: actor.id,
          actorIdSnapshot: actor.id,
          actorNameSnapshot: actorSnapshotName(actor.name),
          targetType: "team",
          targetIdSnapshot: team.id,
          teamIdSnapshot: team.id,
          correlationId: context.correlationId,
          metadata: {
            previousOwnerIdSnapshot: team.createdById,
            newOwnerIdSnapshot: target.id,
            targetPromoted: targetMembership.role !== "ADMIN",
            revokedSessionCount: sessions.count,
          },
          createdAt: context.now,
        });

        return {
          status: "changed",
          revokedSessionCount: sessions.count,
        };
      });
    },
  };
}

const prismaAdminWorkflowRepository =
  createPrismaAdminWorkflowRepository(db);

export function getAdminConsoleData(
  actorUserId: string,
  searchQuery?: string,
  cursors: AdminConsoleCursors = {},
  view?: AdminView,
) {
  return prismaAdminWorkflowRepository.getConsoleData(
    actorUserId,
    searchQuery,
    cursors,
    view,
  );
}

export async function getRateLimitedAdminConsoleData(
  actorUserId: string,
  searchQuery?: string,
  cursors: AdminConsoleCursors = {},
  view?: AdminView,
) {
  await enforceUserRateLimit({
    scope: "admin-collection-read",
    userId: actorUserId,
    limit: 30,
    windowSeconds: 60,
  });

  return getAdminConsoleData(actorUserId, searchQuery, cursors, view);
}

export function setUserEnabled(input: SetUserEnabledInput) {
  return prismaAdminWorkflowRepository.setUserEnabled(input);
}

export function setGlobalRole(input: SetGlobalRoleInput) {
  return prismaAdminWorkflowRepository.setGlobalRole(input);
}

export function revokeTeamMembership(input: RevokeMembershipInput) {
  return prismaAdminWorkflowRepository.revokeMembership(input);
}

export function transferTeamOwnershipWithAudit(
  input: TransferOwnershipInput,
) {
  return prismaAdminWorkflowRepository.transferOwnership(input);
}
