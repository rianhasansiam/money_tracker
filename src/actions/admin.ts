"use server";

import { revalidatePath } from "next/cache";
import type { UserRole } from "@prisma/client";
import {
  type AdminMutationResult,
  revokeTeamMembership,
  setGlobalRole,
  setUserEnabled,
  transferTeamOwnershipWithAudit,
} from "@/lib/admin-workflows";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  InvitationConflictError,
  InvitationOperationNotPermittedError,
  InvitationValidationError,
  createPrismaInvitationRepository,
  provisionInvitation,
  revokeInvitation,
} from "@/lib/invitations";
import {
  SERVER_ERROR_CATEGORY,
  createCorrelationId,
  reportUnexpectedError,
} from "@/lib/observability";
import { runPostCommitTasks } from "@/lib/post-commit";
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  enforceUserRateLimit,
} from "@/lib/rate-limit";
import { RecentAuthenticationRequiredError } from "@/lib/security-policy";
import {
  TeamLifecycleConflictError,
  restoreTeam,
} from "@/lib/team-lifecycle";
import { UserLifecycleConflictError } from "@/lib/user-lifecycle";
import {
  globalRoleInputSchema,
  invitationInputSchema,
  membershipRevocationInputSchema,
  ownershipTransferInputSchema,
  teamLifecycleInputSchema,
  userLifecycleInputSchema,
} from "@/lib/validators/admin";

export type AdminActionResult =
  | {
      status: "success";
      message: string;
    }
  | {
      status: "error";
      message: string;
      retryAfterSeconds?: number;
    };

const ADMIN_REQUEST_UNAVAILABLE_MESSAGE =
  "This administrative request is unavailable. Refresh the console and try again.";
const RECENT_AUTHENTICATION_MESSAGE =
  "For safety, sign out and sign in again before making this administrative change.";
const invitationRepository = createPrismaInvitationRepository(db);

function updateAdminViews(teamId?: string) {
  return runPostCommitTasks([
    () => revalidatePath("/admin"),
    () => revalidatePath("/groups"),
    () => revalidatePath("/dashboard"),
    ...(teamId ? [() => revalidatePath(`/dashboard/${teamId}`)] : []),
  ]);
}

async function requireActor(
  operation: string,
): Promise<
  | { actorUserId: string; error?: never }
  | { actorUserId?: never; error: AdminActionResult }
> {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return {
        error: {
          status: "error",
          message: "Your session has expired. Please sign in again.",
        },
      };
    }

    return { actorUserId: session.user.id };
  } catch (error) {
    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.authentication,
      context: { operation },
    });

    return {
      error: {
        status: "error",
        message: unexpected.message,
      },
    };
  }
}

async function enforceAdminRateLimit(
  actorUserId: string,
  scope: string,
  limit: number,
): Promise<AdminActionResult | null> {
  try {
    await enforceUserRateLimit({
      scope,
      userId: actorUserId,
      limit,
      windowSeconds: 60 * 60,
    });

    return null;
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return {
        status: "error",
        message: `Too many administrative requests. Try again in ${error.retryAfterSeconds} seconds.`,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }

    if (error instanceof RateLimitUnavailableError) {
      return {
        status: "error",
        message:
          "Administrative request protection is temporarily unavailable. No change was attempted.",
      };
    }

    const unexpected = reportUnexpectedError(error, {
      category: SERVER_ERROR_CATEGORY.rateLimit,
      context: { operation: scope },
    });

    return {
      status: "error",
      message: unexpected.message,
    };
  }
}

function mutationErrorResult(result: AdminMutationResult): AdminActionResult | null {
  switch (result.status) {
    case "recent_authentication_required":
      return {
        status: "error",
        message: RECENT_AUTHENTICATION_MESSAGE,
      };
    case "confirmation_mismatch":
      return {
        status: "error",
        message: "Type the exact team name to confirm this change.",
      };
    case "last_admin_required":
      return {
        status: "error",
        message:
          "At least one active global administrator must remain. Promote another administrator first.",
      };
    case "ownership_transfer_required":
      return {
        status: "error",
        message:
          "Team ownership must be transferred before this administrative change can be completed.",
      };
    case "unavailable":
      return {
        status: "error",
        message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
      };
    default:
      return null;
  }
}

function expectedWorkflowError(error: unknown) {
  return (
    error instanceof InvitationConflictError ||
    error instanceof InvitationOperationNotPermittedError ||
    error instanceof InvitationValidationError ||
    error instanceof RecentAuthenticationRequiredError ||
    error instanceof TeamLifecycleConflictError ||
    error instanceof UserLifecycleConflictError
  );
}

function unexpectedAdminError(
  error: unknown,
  correlationId: string,
  operation: string,
): AdminActionResult {
  if (expectedWorkflowError(error)) {
    return {
      status: "error",
      message:
        error instanceof RecentAuthenticationRequiredError
          ? RECENT_AUTHENTICATION_MESSAGE
          : ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const unexpected = reportUnexpectedError(error, {
    category: SERVER_ERROR_CATEGORY.lifecycle,
    correlationId,
    context: {
      operation,
    },
  });

  return {
    status: "error",
    message: unexpected.message,
  };
}

export async function provisionInvitationAction(input: {
  email: string;
  expiresInDays: number;
}): Promise<AdminActionResult> {
  const actor = await requireActor("invitation_provision_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = invitationInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "error",
      message: "Enter a valid email and an expiry from 1 to 30 days.",
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-invitation-provision",
    20,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();
  const now = new Date();

  try {
    await provisionInvitation(invitationRepository, {
      actorUserId,
      email: parsedInput.data.email,
      now,
      expiresAt: new Date(
        now.getTime() + parsedInput.data.expiresInDays * 24 * 60 * 60 * 1_000,
      ),
      correlationId,
    });
    updateAdminViews();

    return {
      status: "success",
      message:
        "Invitation state is up to date. The invited Google identity may sign in while the invitation remains valid.",
    };
  } catch (error) {
    return unexpectedAdminError(
      error,
      correlationId,
      "invitation_provision",
    );
  }
}

export async function revokeInvitationAction(
  email: string,
): Promise<AdminActionResult> {
  const actor = await requireActor("invitation_revoke_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = userLifecycleInputSchema.safeParse({ email });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-invitation-revoke",
    30,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    await revokeInvitation(invitationRepository, {
      actorUserId,
      email: parsedInput.data.email,
      correlationId,
    });
    updateAdminViews();

    return {
      status: "success",
      message: "Invitation state is up to date.",
    };
  } catch (error) {
    return unexpectedAdminError(error, correlationId, "invitation_revoke");
  }
}

export async function disableUserAction(
  email: string,
): Promise<AdminActionResult> {
  return changeUserEnabledState(email, false);
}

export async function reenableUserAction(
  email: string,
): Promise<AdminActionResult> {
  return changeUserEnabledState(email, true);
}

async function changeUserEnabledState(
  email: string,
  enabled: boolean,
): Promise<AdminActionResult> {
  const actor = await requireActor(
    enabled ? "user_enable_authentication" : "user_disable_authentication",
  );

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = userLifecycleInputSchema.safeParse({ email });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    enabled ? "admin-user-enable" : "admin-user-disable",
    20,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await setUserEnabled({
      actorUserId,
      email: parsedInput.data.email,
      enabled,
      correlationId,
    });
    const errorResult = mutationErrorResult(result);

    if (errorResult) {
      return errorResult;
    }

    updateAdminViews();

    return {
      status: "success",
      message: enabled
        ? "The account is enabled. Existing sessions remain revoked; the user must sign in again."
        : "The account is disabled and all of its sessions were revoked.",
    };
  } catch (error) {
    return unexpectedAdminError(
      error,
      correlationId,
      enabled ? "user_enable" : "user_disable",
    );
  }
}

export async function changeGlobalRoleAction(
  email: string,
  role: UserRole,
): Promise<AdminActionResult> {
  const actor = await requireActor("global_role_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = globalRoleInputSchema.safeParse({ email, role });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-global-role",
    20,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await setGlobalRole({
      actorUserId,
      email: parsedInput.data.email,
      role: parsedInput.data.role,
      correlationId,
    });
    const errorResult = mutationErrorResult(result);

    if (errorResult) {
      return errorResult;
    }

    updateAdminViews();

    return {
      status: "success",
      message:
        "The global role is up to date and affected sessions were revoked.",
    };
  } catch (error) {
    return unexpectedAdminError(error, correlationId, "global_role_change");
  }
}

export async function revokeTeamMembershipAction(
  teamId: string,
  email: string,
): Promise<AdminActionResult> {
  const actor = await requireActor("membership_revoke_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = membershipRevocationInputSchema.safeParse({
    teamId,
    email,
  });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-membership-revoke",
    40,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await revokeTeamMembership({
      actorUserId,
      teamId: parsedInput.data.teamId,
      email: parsedInput.data.email,
      correlationId,
    });
    const errorResult = mutationErrorResult(result);

    if (errorResult) {
      return errorResult;
    }

    updateAdminViews(parsedInput.data.teamId);

    return {
      status: "success",
      message:
        "The membership is revoked and the affected user's sessions were revoked.",
    };
  } catch (error) {
    return unexpectedAdminError(
      error,
      correlationId,
      "membership_revoke",
    );
  }
}

export async function transferTeamOwnershipAction(
  teamId: string,
  newOwnerEmail: string,
  confirmedTeamName: string,
): Promise<AdminActionResult> {
  const actor = await requireActor("ownership_transfer_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = ownershipTransferInputSchema.safeParse({
    teamId,
    newOwnerEmail,
    confirmedTeamName,
  });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-ownership-transfer",
    10,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await transferTeamOwnershipWithAudit({
      actorUserId,
      teamId: parsedInput.data.teamId,
      newOwnerEmail: parsedInput.data.newOwnerEmail,
      confirmedTeamName: parsedInput.data.confirmedTeamName,
      correlationId,
    });
    const errorResult = mutationErrorResult(result);

    if (errorResult) {
      return errorResult;
    }

    updateAdminViews(parsedInput.data.teamId);

    return {
      status: "success",
      message:
        "Team ownership is up to date. Affected users must sign in again.",
    };
  } catch (error) {
    return unexpectedAdminError(
      error,
      correlationId,
      "ownership_transfer",
    );
  }
}

export async function restoreTeamAction(
  teamId: string,
  confirmedTeamName: string,
): Promise<AdminActionResult> {
  const actor = await requireActor("team_restore_authentication");

  if (actor.error) {
    return actor.error;
  }

  const { actorUserId } = actor;

  const parsedInput = teamLifecycleInputSchema.safeParse({
    teamId,
    confirmedTeamName,
  });

  if (!parsedInput.success) {
    return {
      status: "error",
      message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
    };
  }

  const rateLimitResult = await enforceAdminRateLimit(
    actorUserId,
    "admin-team-restore",
    10,
  );

  if (rateLimitResult) {
    return rateLimitResult;
  }

  const correlationId = createCorrelationId();

  try {
    const result = await restoreTeam(actorUserId, {
      teamId: parsedInput.data.teamId,
      confirmedTeamName: parsedInput.data.confirmedTeamName,
      correlationId,
    });

    if (result.status === "recent_authentication_required") {
      return {
        status: "error",
        message: RECENT_AUTHENTICATION_MESSAGE,
      };
    }

    if (result.status === "confirmation_mismatch") {
      return {
        status: "error",
        message: "Type the exact team name to confirm restoration.",
      };
    }

    if (result.status === "retention_expired") {
      return {
        status: "error",
        message:
          "This team is no longer within the restoration window. Use the documented purge review process.",
      };
    }

    if (result.status === "unavailable") {
      return {
        status: "error",
        message: ADMIN_REQUEST_UNAVAILABLE_MESSAGE,
      };
    }

    updateAdminViews(result.teamId);

    return {
      status: "success",
      message: "Team restored with its memberships and ledger intact.",
    };
  } catch (error) {
    return unexpectedAdminError(error, correlationId, "team_restore");
  }
}
