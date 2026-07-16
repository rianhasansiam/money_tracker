import type { Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit-events";
import { db } from "@/lib/db";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";
import {
  isRecentAuthentication,
  RECENT_AUTHENTICATION_MAX_AGE_MS,
} from "@/lib/security-policy";

export const TEAM_DELETION_RETENTION_DAYS = 30;
export { RECENT_AUTHENTICATION_MAX_AGE_MS };
const SERIALIZABLE_ATTEMPTS = 3;

export type TeamQuarantineResult =
  | {
      status: "quarantined";
      teamId: string;
      purgeAfter: Date;
    }
  | {
      status: "already_quarantined";
      teamId: string;
      purgeAfter: Date;
    }
  | {
      status: "confirmation_mismatch";
    }
  | {
      status: "recent_authentication_required";
    }
  | {
      status: "unavailable";
    };

export type TeamRestoreResult =
  | {
      status: "restored";
      teamId: string;
    }
  | {
      status: "confirmation_mismatch";
    }
  | {
      status: "recent_authentication_required";
    }
  | {
      status: "retention_expired";
    }
  | {
      status: "unavailable";
    };

export type TeamPurgeResult =
  | {
      status: "purged";
    }
  | {
      status:
        | "confirmation_mismatch"
        | "not_eligible"
        | "unavailable";
    };

export class TeamLifecycleConflictError extends Error {
  constructor() {
    super("The team lifecycle operation conflicted with another write.");
    this.name = "TeamLifecycleConflictError";
  }
}

function assertValidDate(value: Date) {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("A valid lifecycle timestamp is required.");
  }
}

function assertSafeAuditValue(value: string, maxLength: number) {
  if (value.length === 0 || value.length > maxLength) {
    throw new TypeError("A valid audit value is required.");
  }
}

function addRetentionPeriod(now: Date) {
  return new Date(
    now.getTime() + TEAM_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

function actorDisplayName(name: string | null) {
  const normalizedName = name?.trim();
  return normalizedName ? normalizedName.slice(0, 160) : "Administrator";
}

async function runSerializable<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        hasPrismaErrorCode(error, "P2034") &&
        attempt < SERIALIZABLE_ATTEMPTS - 1
      ) {
        continue;
      }

      if (hasPrismaErrorCode(error, "P2034")) {
        throw new TeamLifecycleConflictError();
      }

      throw error;
    }
  }

  throw new TeamLifecycleConflictError();
}

async function findActiveAdministrator(
  tx: Prisma.TransactionClient,
  actorUserId: string,
) {
  return tx.user.findFirst({
    where: {
      id: actorUserId,
      role: "ADMIN",
      status: "ACTIVE",
      disabledAt: null,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      lastAuthenticatedAt: true,
    },
  });
}

function hasRecentAuthentication(
  lastAuthenticatedAt: Date | null,
  now: Date,
) {
  return isRecentAuthentication(lastAuthenticatedAt, now);
}

export async function quarantineTeam(
  actorUserId: string,
  input: {
    teamId: string;
    confirmedTeamName: string;
    correlationId: string;
    now?: Date;
  },
): Promise<TeamQuarantineResult> {
  const now = input.now ?? new Date();
  assertValidDate(now);
  assertSafeAuditValue(input.correlationId, 64);

  return runSerializable(async (tx) => {
    const actor = await findActiveAdministrator(tx, actorUserId);

    if (!actor) {
      return { status: "unavailable" };
    }

    if (!hasRecentAuthentication(actor.lastAuthenticatedAt, now)) {
      return { status: "recent_authentication_required" };
    }

    const team = await tx.team.findUnique({
      where: { id: input.teamId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        purgeAfter: true,
      },
    });

    if (!team) {
      return { status: "unavailable" };
    }

    if (input.confirmedTeamName !== team.name) {
      return { status: "confirmation_mismatch" };
    }

    if (team.deletedAt) {
      if (!team.purgeAfter) {
        return { status: "unavailable" };
      }

      return {
        status: "already_quarantined",
        teamId: team.id,
        purgeAfter: team.purgeAfter,
      };
    }

    const purgeAfter = addRetentionPeriod(now);
    const quarantined = await tx.team.updateMany({
      where: {
        id: team.id,
        deletedAt: null,
      },
      data: {
        deletedAt: now,
        purgeAfter,
        deletedById: actor.id,
      },
    });

    if (quarantined.count !== 1) {
      throw new TeamLifecycleConflictError();
    }

    await recordAuditEvent(tx, {
      action: "TEAM_QUARANTINED",
      actorUserId: actor.id,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: actorDisplayName(actor.name),
      targetType: "TEAM",
      targetIdSnapshot: team.id,
      teamIdSnapshot: team.id,
      correlationId: input.correlationId,
      metadata: {
        retentionDays: TEAM_DELETION_RETENTION_DAYS,
      },
    });

    return {
      status: "quarantined",
      teamId: team.id,
      purgeAfter,
    };
  });
}

export async function restoreTeam(
  actorUserId: string,
  input: {
    teamId: string;
    confirmedTeamName: string;
    correlationId: string;
    now?: Date;
  },
): Promise<TeamRestoreResult> {
  const now = input.now ?? new Date();
  assertValidDate(now);
  assertSafeAuditValue(input.correlationId, 64);

  return runSerializable(async (tx) => {
    const actor = await findActiveAdministrator(tx, actorUserId);

    if (!actor) {
      return { status: "unavailable" };
    }

    if (!hasRecentAuthentication(actor.lastAuthenticatedAt, now)) {
      return { status: "recent_authentication_required" };
    }

    const team = await tx.team.findUnique({
      where: { id: input.teamId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        purgeAfter: true,
      },
    });

    if (!team?.deletedAt || !team.purgeAfter) {
      return { status: "unavailable" };
    }

    if (input.confirmedTeamName !== team.name) {
      return { status: "confirmation_mismatch" };
    }

    if (team.purgeAfter <= now) {
      return { status: "retention_expired" };
    }

    const restored = await tx.team.updateMany({
      where: {
        id: team.id,
        deletedAt: { not: null },
        purgeAfter: { gt: now },
      },
      data: {
        deletedAt: null,
        purgeAfter: null,
        deletedById: null,
      },
    });

    if (restored.count !== 1) {
      throw new TeamLifecycleConflictError();
    }

    await recordAuditEvent(tx, {
      action: "TEAM_RESTORED",
      actorUserId: actor.id,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: actorDisplayName(actor.name),
      targetType: "TEAM",
      targetIdSnapshot: team.id,
      teamIdSnapshot: team.id,
      correlationId: input.correlationId,
    });

    return {
      status: "restored",
      teamId: team.id,
    };
  });
}

export async function purgeTeamAfterRetention(input: {
  actorEmail: string;
  teamId: string;
  confirmedTeamName: string;
  backupReference: string;
  correlationId: string;
  now?: Date;
}): Promise<TeamPurgeResult> {
  const now = input.now ?? new Date();
  assertValidDate(now);
  assertSafeAuditValue(input.backupReference, 120);
  assertSafeAuditValue(input.correlationId, 64);
  const canonicalActorEmail = input.actorEmail.trim().toLowerCase();

  return runSerializable(async (tx) => {
    const actors = await tx.user.findMany({
      where: {
        email: {
          equals: canonicalActorEmail,
          mode: "insensitive",
        },
        role: "ADMIN",
        status: "ACTIVE",
        disabledAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
      },
      take: 2,
    });

    if (actors.length !== 1) {
      return { status: "unavailable" };
    }

    const actor = actors[0];
    const team = await tx.team.findUnique({
      where: { id: input.teamId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        purgeAfter: true,
      },
    });

    if (!team) {
      return { status: "unavailable" };
    }

    if (input.confirmedTeamName !== team.name) {
      return { status: "confirmation_mismatch" };
    }

    if (!team.deletedAt || !team.purgeAfter || team.purgeAfter > now) {
      return { status: "not_eligible" };
    }

    await recordAuditEvent(tx, {
      action: "TEAM_PERMANENTLY_PURGED",
      actorUserId: actor.id,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: actorDisplayName(actor.name),
      targetType: "TEAM",
      targetIdSnapshot: team.id,
      teamIdSnapshot: team.id,
      correlationId: input.correlationId,
      metadata: {
        backupReference: input.backupReference,
        retentionExpiredAt: team.purgeAfter.toISOString(),
      },
    });

    const purged = await tx.team.deleteMany({
      where: {
        id: team.id,
        deletedAt: { not: null },
        purgeAfter: { lte: now },
      },
    });

    if (purged.count !== 1) {
      throw new TeamLifecycleConflictError();
    }

    return { status: "purged" };
  });
}
