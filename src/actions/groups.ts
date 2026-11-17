"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit-events";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  createCorrelationId,
  reportUnexpectedError,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";
import { runPostCommitTasks } from "@/lib/post-commit";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  enforceUserRateLimit,
} from "@/lib/rate-limit";
import { canCreateOrDeleteGroups } from "@/lib/roles";
import {
  quarantineTeam,
  TeamLifecycleConflictError,
} from "@/lib/team-lifecycle";
import { teamLifecycleInputSchema } from "@/lib/validators/admin";
import {
  createTeamFormSchema,
  membershipIdSchema,
  teamIdSchema,
  type CreateTeamFormValues,
  flattenCreateTeamErrors,
} from "@/lib/validators/team";

export type GroupActionResult =
  | {
      status: "success";
      message: string;
      teamId?: string;
    }
  | {
      status: "error";
      message: string;
      retryAfterSeconds?: number;
      code?: "RECENT_AUTHENTICATION_REQUIRED";
      fieldErrors?: Partial<Record<keyof CreateTeamFormValues, string>>;
    };

const GROUP_ACTION_UNAVAILABLE_MESSAGE =
  "This team request cannot be processed. Refresh the page and try again.";
const SERIALIZABLE_ATTEMPTS = 3;

class GroupActionUnavailableError extends Error {
  constructor() {
    super("The requested group operation is unavailable.");
    this.name = "GroupActionUnavailableError";
  }
}

function containsErrorValue(
  value: unknown,
  expected: string,
  depth = 0,
): boolean {
  if (depth > 5) {
    return false;
  }

  if (typeof value === "string") {
    return value === expected || value.includes(expected);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => containsErrorValue(entry, expected, depth + 1));
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) =>
      containsErrorValue(entry, expected, depth + 1),
    );
  }

  return false;
}

function isSerializationConflict(error: unknown) {
  return (
    hasPrismaErrorCode(error, "P2034") ||
    (hasPrismaErrorCode(error, "P2010") &&
      containsErrorValue(error, "40001"))
  );
}

function actorDisplayName(name: string | null) {
  return name?.trim().slice(0, 160) || "Administrator";
}

function isGlobalAdmin(
  session: { user?: { role?: string | null } | null } | null | undefined,
) {
  return canCreateOrDeleteGroups(session?.user?.role);
}

function updateGroupViews(teamId?: string) {
  return runPostCommitTasks([
    () => revalidatePath("/groups"),
    () => revalidatePath("/dashboard"),
    ...(teamId ? [() => revalidatePath(`/dashboard/${teamId}`)] : []),
  ]);
}

async function runSerializableGroupOperation<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        isSerializationConflict(error) &&
        attempt < SERIALIZABLE_ATTEMPTS - 1
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new GroupActionUnavailableError();
}

async function enforceGroupActionRateLimit(
  userId: string,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<GroupActionResult | null> {
  try {
    await enforceUserRateLimit({
      scope,
      userId,
      limit,
      windowSeconds,
    });

    return null;
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return {
        status: "error",
        message: `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }

    if (error instanceof RateLimitUnavailableError) {
      return {
        status: "error",
        message:
          "Request protection is temporarily unavailable. No change was attempted.",
      };
    }

    throw error;
  }
}

export async function createTeam(
  input: CreateTeamFormValues,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  if (!isGlobalAdmin(session)) {
    return {
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    };
  }

  const parsedInput = createTeamFormSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: flattenCreateTeamErrors(parsedInput.error),
    };
  }

  const rateLimitResult = await enforceGroupActionRateLimit(
    session.user.id,
    "team-create",
    10,
    60 * 60,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const team = await runSerializableGroupOperation(async (tx) => {
      const administrator = await tx.user.findFirst({
        where: {
          id: session.user.id,
          role: "ADMIN",
          status: "ACTIVE",
          disabledAt: null,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!administrator) {
        throw new GroupActionUnavailableError();
      }

      const createdTeam = await tx.team.create({
        data: {
          name: parsedInput.data.name,
          description: parsedInput.data.description || null,
          createdById: administrator.id,
        },
        select: {
          id: true,
        },
      });

      await tx.teamMembership.create({
        data: {
          teamId: createdTeam.id,
          userId: administrator.id,
          role: "ADMIN",
          status: "APPROVED",
          approvedAt: new Date(),
          approvedById: administrator.id,
        },
      });

      await recordAuditEvent(tx, {
        action: "TEAM_CREATED",
        actorUserId: administrator.id,
        actorIdSnapshot: administrator.id,
        actorNameSnapshot: actorDisplayName(administrator.name),
        targetType: "TEAM",
        targetIdSnapshot: createdTeam.id,
        teamIdSnapshot: createdTeam.id,
        correlationId,
      });

      return createdTeam;
    });
    const viewsUpdated = updateGroupViews(team.id);

    return {
      status: "success",
      message: viewsUpdated
        ? "Team created. You are its Owner and first Team Admin."
        : "Team created. Refresh the page to update this view.",
      teamId: team.id,
    };
  } catch (error) {
    if (hasPrismaErrorCode(error, "P2002")) {
      return {
        status: "error",
        message: "A team with this name already exists. Choose another name.",
        fieldErrors: {
          name: "A team with this name already exists.",
        },
      };
    }

    if (
      error instanceof GroupActionUnavailableError ||
      isSerializationConflict(error)
    ) {
      return {
        status: "error",
        message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
      };
    }

    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.dataAccess,
      correlationId,
      context: { operation: "team_create" },
    });

    return {
      status: "error",
      message: unexpected.message,
    };
  }
}

export async function quarantineTeamAction(
  teamId: string,
  confirmedTeamName: string,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedInput = teamLifecycleInputSchema.safeParse({
    teamId,
    confirmedTeamName,
  });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceGroupActionRateLimit(
    session.user.id,
    "team-quarantine",
    5,
    60 * 60,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await quarantineTeam(session.user.id, {
      teamId: parsedInput.data.teamId,
      confirmedTeamName: parsedInput.data.confirmedTeamName,
      correlationId,
    });

    if (result.status === "recent_authentication_required") {
      return {
        status: "error",
        code: "RECENT_AUTHENTICATION_REQUIRED",
        message:
          "For safety, sign out and sign in again before quarantining a team.",
      };
    }

    if (result.status === "confirmation_mismatch") {
      return {
        status: "error",
        message: "Type the exact team name to confirm quarantine.",
      };
    }

    if (result.status === "unavailable") {
      return {
        status: "error",
        message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
      };
    }

    const viewsUpdated = updateGroupViews(result.teamId);

    return {
      status: "success",
      message:
        result.status === "already_quarantined"
          ? "This team is already quarantined. Its retained ledger was not changed."
          : viewsUpdated
            ? "Team quarantined. Its ledger remains recoverable during retention."
            : "Team quarantined. Refresh the page to update this view.",
    };
  } catch (error) {
    if (
      error instanceof TeamLifecycleConflictError ||
      hasPrismaErrorCode(error, "P2025") ||
      isSerializationConflict(error)
    ) {
      return {
        status: "error",
        message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
      };
    }

    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.lifecycle,
      correlationId,
      context: { operation: "team_quarantine" },
    });

    return {
      status: "error",
      message: unexpected.message,
    };
  }
}

export async function requestTeamAccess(
  teamId: string,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedTeamId = teamIdSchema.safeParse(teamId);

  if (!parsedTeamId.success) {
    return {
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceGroupActionRateLimit(
    session.user.id,
    "membership-request",
    10,
    60,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  let membership: {
    status: "PENDING" | "APPROVED";
    team: { id: string; name: string };
  } | null = null;

  try {
    membership = await runSerializableGroupOperation(async (tx) => {
      const actor = await tx.user.findFirst({
        where: {
          id: session.user.id,
          status: "ACTIVE",
          disabledAt: null,
          deletedAt: null,
        },
        select: { id: true },
      });
      const team = await tx.team.findFirst({
        where: {
          id: parsedTeamId.data,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!actor || !team) {
        throw new GroupActionUnavailableError();
      }

      const existingMembership = await tx.teamMembership.findUnique({
        where: {
          teamId_userId: {
            teamId: team.id,
            userId: actor.id,
          },
        },
        select: {
          status: true,
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (existingMembership) {
        if (
          existingMembership.status !== "PENDING" &&
          existingMembership.status !== "APPROVED"
        ) {
          throw new GroupActionUnavailableError();
        }

        return {
          status: existingMembership.status,
          team: existingMembership.team,
        };
      }

      const createdMembership = await tx.teamMembership.create({
        data: {
          teamId: team.id,
          userId: actor.id,
          role: "MEMBER",
          status: "PENDING",
        },
        select: {
          status: true,
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return {
        status: "PENDING" as const,
        team: createdMembership.team,
      };
    });
  } catch (error) {
    if (hasPrismaErrorCode(error, "P2002")) {
      const existingMembership = await db.teamMembership.findFirst({
        where: {
          teamId: parsedTeamId.data,
          userId: session.user.id,
          status: { in: ["PENDING", "APPROVED"] },
          team: { deletedAt: null },
          user: {
            status: "ACTIVE",
            disabledAt: null,
            deletedAt: null,
          },
        },
        select: {
          status: true,
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      membership =
        existingMembership?.status === "PENDING" ||
        existingMembership?.status === "APPROVED"
          ? {
              status: existingMembership.status,
              team: existingMembership.team,
            }
          : null;
    } else if (
      error instanceof GroupActionUnavailableError ||
      hasPrismaErrorCode(error, "P2003") ||
      hasPrismaErrorCode(error, "P2025") ||
      isSerializationConflict(error)
    ) {
      return {
        status: "error",
        message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
      };
    } else {
      const unexpected = reportUnexpectedError(error, {
        category: SERVER_ERROR_CATEGORY.dataAccess,
        context: { operation: "membership_request" },
      });

      return {
        status: "error",
        message: unexpected.message,
      };
    }
  }

  if (!membership) {
    return {
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    };
  }

  const viewsUpdated = updateGroupViews(membership.team.id);

  return {
    status: "success",
    message:
      membership.status === "APPROVED"
        ? `You already have access to ${membership.team.name}.`
        : viewsUpdated
          ? `Join request sent to ${membership.team.name}.`
          : "Join request saved. Refresh the page to update this view.",
  };
}

export async function approveTeamAccess(
  membershipId: string,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedMembershipId = membershipIdSchema.safeParse(membershipId);

  if (!parsedMembershipId.success) {
    return {
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceGroupActionRateLimit(
    session.user.id,
    "membership-approval",
    60,
    60,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const pendingMembership = await runSerializableGroupOperation(async (tx) => {
      const lockedActors = await tx.$queryRaw<
        Array<{
          id: string;
          name: string | null;
          role: "ADMIN" | "MODERATOR" | "MEMBER";
          status: "PENDING" | "ACTIVE" | "DISABLED" | "DELETED";
          disabledAt: Date | null;
          deletedAt: Date | null;
        }>
      >`
        SELECT "id", "name", "role", "status", "disabledAt", "deletedAt"
        FROM "User"
        WHERE "id" = ${session.user.id}
        FOR UPDATE
      `;
      const actor = lockedActors[0];

      if (
        !actor ||
        actor.status !== "ACTIVE" ||
        actor.disabledAt !== null ||
        actor.deletedAt !== null
      ) {
        throw new GroupActionUnavailableError();
      }

      const approvableMembership = await tx.teamMembership.findFirst({
        where: {
          id: parsedMembershipId.data,
          status: "PENDING",
          user: {
            status: "ACTIVE",
            disabledAt: null,
            deletedAt: null,
          },
          team: {
            deletedAt: null,
            memberships: {
              some: {
                userId: actor.id,
                status: "APPROVED",
                role: { in: ["ADMIN", "MODERATOR"] },
              },
            },
          },
        },
        select: {
          id: true,
          teamId: true,
          user: {
            select: { name: true },
          },
          team: {
            select: { name: true },
          },
        },
      });

      if (!approvableMembership) {
        throw new GroupActionUnavailableError();
      }

      const lockedTeams = await tx.$queryRaw<
        Array<{ id: string; deletedAt: Date | null }>
      >`
        SELECT "id", "deletedAt"
        FROM "Team"
        WHERE "id" = ${approvableMembership.teamId}
        FOR UPDATE
      `;

      if (lockedTeams[0]?.deletedAt !== null) {
        throw new GroupActionUnavailableError();
      }

      const lockedMemberships = await tx.$queryRaw<
        Array<{
          id: string;
          userId: string;
          role: "ADMIN" | "MODERATOR" | "MEMBER";
          status: "PENDING" | "APPROVED" | "REVOKED";
        }>
      >`
        SELECT "id", "userId", "role", "status"
        FROM "TeamMembership"
        WHERE "id" = ${approvableMembership.id}
           OR ("teamId" = ${approvableMembership.teamId}
               AND "userId" = ${actor.id})
        ORDER BY "id"
        FOR UPDATE
      `;
      const lockedRequest = lockedMemberships.find(
        (membership) => membership.id === approvableMembership.id,
      );
      const lockedApprover = lockedMemberships.find(
        (membership) => membership.userId === actor.id,
      );

      if (
        lockedRequest?.status !== "PENDING" ||
        lockedApprover?.status !== "APPROVED" ||
        !["ADMIN", "MODERATOR"].includes(lockedApprover.role)
      ) {
        throw new GroupActionUnavailableError();
      }

      const transitioned = await tx.teamMembership.updateMany({
        where: {
          id: approvableMembership.id,
          status: "PENDING",
        },
        data: {
          status: "APPROVED",
          approvedAt: new Date(),
          approvedById: actor.id,
        },
      });

      if (transitioned.count !== 1) {
        throw new GroupActionUnavailableError();
      }

      await recordAuditEvent(tx, {
        action: "TEAM_MEMBERSHIP_APPROVED",
        actorUserId: actor.id,
        actorIdSnapshot: actor.id,
        actorNameSnapshot: actorDisplayName(actor.name),
        targetType: "TEAM_MEMBERSHIP",
        targetIdSnapshot: approvableMembership.id,
        teamIdSnapshot: approvableMembership.teamId,
        correlationId,
      });

      return approvableMembership;
    });
    const viewsUpdated = updateGroupViews(pendingMembership.teamId);
    const requesterLabel = pendingMembership.user.name || "This member";

    return {
      status: "success",
      message: viewsUpdated
        ? `${requesterLabel} can now view ${pendingMembership.team.name}.`
        : "Membership approved. Refresh the page to update this view.",
    };
  } catch (error) {
    if (
      error instanceof GroupActionUnavailableError ||
      hasPrismaErrorCode(error, "P2002") ||
      hasPrismaErrorCode(error, "P2025") ||
      isSerializationConflict(error)
    ) {
      return {
        status: "error",
        message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
      };
    }

    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.dataAccess,
      correlationId,
      context: { operation: "membership_approval" },
    });

    return {
      status: "error",
      message: unexpected.message,
    };
  }
}
