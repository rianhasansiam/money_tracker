import { beforeEach, describe, expect, it, vi } from "vitest";

const adminActionMocks = vi.hoisted(() => {
  class InvitationConflictError extends Error {}
  class InvitationOperationNotPermittedError extends Error {}
  class InvitationValidationError extends Error {}
  class RateLimitExceededError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("Rate limit exceeded.");
    }
  }
  class RateLimitUnavailableError extends Error {}
  class RecentAuthenticationRequiredError extends Error {}
  class TeamLifecycleConflictError extends Error {}
  class UserLifecycleConflictError extends Error {}

  return {
    auth: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    canonicalSignInUrl: vi.fn(),
    changeRole: vi.fn(),
    createCorrelationId: vi.fn(() => "4f635d30-b641-4944-b66f-c3beac114f8a"),
    disableOrEnable: vi.fn(),
    enforceUserRateLimit: vi.fn(),
    InvitationConflictError,
    InvitationOperationNotPermittedError,
    InvitationValidationError,
    provisionInvitation: vi.fn(),
    RateLimitExceededError,
    RateLimitUnavailableError,
    RecentAuthenticationRequiredError,
    reportUnexpectedError: vi.fn(() => ({
      correlationId: "4f635d30-b641-4944-b66f-c3beac114f8a",
      message:
        "Something went wrong. Try again later. Reference: 4f635d30-b641-4944-b66f-c3beac114f8a.",
    })),
    restoreTeam: vi.fn(),
    revokeInvitation: vi.fn(),
    revokeMembership: vi.fn(),
    revalidatePath: vi.fn(),
    TeamLifecycleConflictError,
    transferOwnership: vi.fn(),
    UserLifecycleConflictError,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: adminActionMocks.revalidatePath,
}));

vi.mock("@/lib/auth", () => ({
  auth: adminActionMocks.auth,
}));

vi.mock("@/lib/access-instructions", () => ({ canonicalSignInUrl: adminActionMocks.canonicalSignInUrl }));

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@/lib/admin-workflows", () => ({
  setUserEnabled: adminActionMocks.disableOrEnable,
  setGlobalRole: adminActionMocks.changeRole,
  revokeTeamMembership: adminActionMocks.revokeMembership,
  transferTeamOwnershipWithAudit: adminActionMocks.transferOwnership,
}));

vi.mock("@/lib/invitations", () => ({
  InvitationConflictError: adminActionMocks.InvitationConflictError,
  InvitationOperationNotPermittedError:
    adminActionMocks.InvitationOperationNotPermittedError,
  InvitationValidationError: adminActionMocks.InvitationValidationError,
  createPrismaInvitationRepository: vi.fn(() => ({})),
  provisionInvitation: adminActionMocks.provisionInvitation,
  revokeInvitation: adminActionMocks.revokeInvitation,
}));

vi.mock("@/lib/observability", () => ({
  SERVER_ERROR_CATEGORY: { lifecycle: "lifecycle" },
  createCorrelationId: adminActionMocks.createCorrelationId,
  reportUnexpectedError: adminActionMocks.reportUnexpectedError,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: adminActionMocks.enforceUserRateLimit,
  RateLimitExceededError: adminActionMocks.RateLimitExceededError,
  RateLimitUnavailableError: adminActionMocks.RateLimitUnavailableError,
}));

vi.mock("@/lib/security-policy", () => ({
  RecentAuthenticationRequiredError:
    adminActionMocks.RecentAuthenticationRequiredError,
}));

vi.mock("@/lib/team-lifecycle", () => ({
  TeamLifecycleConflictError: adminActionMocks.TeamLifecycleConflictError,
  restoreTeam: adminActionMocks.restoreTeam,
}));

vi.mock("@/lib/user-lifecycle", () => ({
  UserLifecycleConflictError: adminActionMocks.UserLifecycleConflictError,
}));

import {
  changeGlobalRoleAction,
  disableUserAction,
  provisionInvitationAction,
  reenableUserAction,
  restoreTeamAction,
  revokeInvitationAction,
  revokeTeamMembershipAction,
  transferTeamOwnershipAction,
} from "@/actions/admin";

const TEAM_ID = "clh1234567890abcdefghijk";

describe("administrative Server Action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminActionMocks.canonicalSignInUrl.mockReturnValue("https://ledger.example.test/login");
    adminActionMocks.auth.mockResolvedValue({ user: { id: "actor-internal-id" } });
    adminActionMocks.enforceUserRateLimit.mockResolvedValue({ allowed: true });
    adminActionMocks.disableOrEnable.mockResolvedValue({
      status: "changed",
      revokedSessionCount: 1,
    });
    adminActionMocks.changeRole.mockResolvedValue({
      status: "changed",
      revokedSessionCount: 1,
    });
    adminActionMocks.revokeMembership.mockResolvedValue({
      status: "changed",
      revokedSessionCount: 1,
    });
    adminActionMocks.transferOwnership.mockResolvedValue({
      status: "changed",
      revokedSessionCount: 2,
    });
    adminActionMocks.restoreTeam.mockResolvedValue({
      status: "restored",
      teamId: TEAM_ID,
    });
    adminActionMocks.provisionInvitation.mockResolvedValue({
      status: "created",
      invitationId: "hidden-invitation-id",
      expiresAt: new Date("2026-07-22T10:00:00.000Z"),
    });
  });

  it.each([
    [
      "invitation provision",
      () =>
        provisionInvitationAction({
          email: "target@example.com",
          expiresInDays: 7,
        }),
    ],
    ["invitation revocation", () => revokeInvitationAction("target@example.com")],
    ["user disablement", () => disableUserAction("target@example.com")],
    ["user re-enablement", () => reenableUserAction("target@example.com")],
    [
      "global-role change",
      () => changeGlobalRoleAction("target@example.com", "MEMBER"),
    ],
    [
      "membership revocation",
      () => revokeTeamMembershipAction(TEAM_ID, "target@example.com"),
    ],
    [
      "ownership transfer",
      () =>
        transferTeamOwnershipAction(
          TEAM_ID,
          "target@example.com",
          "Treasury",
        ),
    ],
    ["team restoration", () => restoreTeamAction(TEAM_ID, "Treasury")],
  ])("rejects anonymous %s before rate-limit or mutation work", async (_label, invoke) => {
    adminActionMocks.auth.mockResolvedValue(null);

    await expect(invoke()).resolves.toEqual({
      status: "error",
      message: "Your session has expired. Please sign in again.",
    });
    expect(adminActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(adminActionMocks.provisionInvitation).not.toHaveBeenCalled();
    expect(adminActionMocks.revokeInvitation).not.toHaveBeenCalled();
    expect(adminActionMocks.disableOrEnable).not.toHaveBeenCalled();
    expect(adminActionMocks.changeRole).not.toHaveBeenCalled();
    expect(adminActionMocks.revokeMembership).not.toHaveBeenCalled();
    expect(adminActionMocks.transferOwnership).not.toHaveBeenCalled();
    expect(adminActionMocks.restoreTeam).not.toHaveBeenCalled();
  });

  it("validates an invitation before rate-limit or database work", async () => {
    const result = await provisionInvitationAction({
      email: "not-an-email",
      expiresInDays: 7,
    });

    expect(result.status).toBe("error");
    expect(adminActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(adminActionMocks.provisionInvitation).not.toHaveBeenCalled();
  });

  it("rate limits before an account mutation and returns retry timing", async () => {
    adminActionMocks.enforceUserRateLimit.mockRejectedValue(
      new adminActionMocks.RateLimitExceededError(31),
    );

    const result = await disableUserAction("target@example.com");

    expect(result).toMatchObject({
      status: "error",
      retryAfterSeconds: 31,
    });
    expect(adminActionMocks.disableOrEnable).not.toHaveBeenCalled();
  });

  it("correlation-logs an unexpected limiter failure before mutation", async () => {
    adminActionMocks.enforceUserRateLimit.mockRejectedValue(
      new Error("unexpected dependency failure"),
    );

    const result = await disableUserAction("target@example.com");

    expect(result.message).toContain("Reference:");
    expect(adminActionMocks.reportUnexpectedError).toHaveBeenCalled();
    expect(adminActionMocks.disableOrEnable).not.toHaveBeenCalled();
  });

  it("correlation-logs an unexpected session lookup failure", async () => {
    adminActionMocks.auth.mockRejectedValue(new Error("session store failure"));

    const result = await disableUserAction("target@example.com");

    expect(result.message).toContain("Reference:");
    expect(adminActionMocks.reportUnexpectedError).toHaveBeenCalled();
    expect(adminActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(adminActionMocks.disableOrEnable).not.toHaveBeenCalled();
  });

  it("never serializes invitation or actor identifiers in a success response", async () => {
    const result = await provisionInvitationAction({
      email: "Invited@Example.com",
      expiresInDays: 7,
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("success");
    expect(adminActionMocks.provisionInvitation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "actor-internal-id",
        email: "invited@example.com",
      }),
    );
    expect(serialized).not.toContain("hidden-invitation-id");
    expect(serialized).not.toContain("actor-internal-id");
  });

  it("uses a stable owner-transfer response without invoking cache refresh", async () => {
    adminActionMocks.disableOrEnable.mockResolvedValue({
      status: "ownership_transfer_required",
    });

    const result = await disableUserAction("owner@example.com");

    expect(result).toEqual({
      status: "error",
      message:
        "Team ownership must be transferred before this administrative change can be completed.",
    });
    expect(adminActionMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("applies validated role and membership operations through the DAL", async () => {
    const roleResult = await changeGlobalRoleAction(
      "target@example.com",
      "MODERATOR",
    );
    const membershipResult = await revokeTeamMembershipAction(
      TEAM_ID,
      "target@example.com",
    );

    expect(roleResult.status).toBe("success");
    expect(membershipResult.status).toBe("success");
    expect(adminActionMocks.changeRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-internal-id",
        email: "target@example.com",
        role: "MODERATOR",
      }),
    );
    expect(adminActionMocks.revokeMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "actor-internal-id",
        teamId: TEAM_ID,
        email: "target@example.com",
      }),
    );
  });

  it("requires exact typed confirmation for ownership transfer", async () => {
    adminActionMocks.transferOwnership.mockResolvedValue({
      status: "confirmation_mismatch",
    });

    const result = await transferTeamOwnershipAction(
      TEAM_ID,
      "target@example.com",
      "wrong name",
    );

    expect(result).toEqual({
      status: "error",
      message: "Type the exact team name to confirm this change.",
    });
  });

  it("maps the restoration recent-auth requirement without leaking records", async () => {
    adminActionMocks.restoreTeam.mockResolvedValue({
      status: "recent_authentication_required",
    });

    const result = await restoreTeamAction(TEAM_ID, "Treasury");

    expect(result).toEqual({
      status: "error",
      code: "RECENT_AUTHENTICATION_REQUIRED",
      message:
        "For safety, sign out and sign in again before making this administrative change.",
    });
    expect(JSON.stringify(result)).not.toContain(TEAM_ID);
  });

  it("returns the normalized email, persisted actual expiry and canonical instructions URL", async () => {
    adminActionMocks.provisionInvitation.mockResolvedValue({
      status: "unchanged", invitationId: "hidden-invitation-id", expiresAt: new Date("2026-11-20T10:00:00.000Z"),
    });
    const result = await provisionInvitationAction({ email: " Existing@Example.com ", expiresInDays: 30 });
    expect(result).toMatchObject({ status: "success", invitation: {
      outcome: "unchanged", email: "existing@example.com", expiresAt: "2026-11-20T10:00:00.000Z", signInUrl: "https://ledger.example.test/login",
    } });
    expect(result.message).toContain("existing expiry is unchanged");
    expect(result.message).toContain("No email has been sent");
  });

  it("does not claim a new invitation for an already-active identity", async () => {
    adminActionMocks.provisionInvitation.mockResolvedValue({ status: "already_active", invitationId: null, expiresAt: null });
    const result = await provisionInvitationAction({ email: "active@example.com", expiresInDays: 7 });
    expect(result).toMatchObject({ status: "success", invitation: { outcome: "already_active", expiresAt: null } });
    expect(result.message).toContain("No new invitation was created");
  });

  it("does not mutate an invitation when no trusted sign-in origin can be resolved", async () => {
    adminActionMocks.canonicalSignInUrl.mockReturnValue(null);
    const result = await provisionInvitationAction({ email: "target@example.com", expiresInDays: 7 });
    expect(result.status).toBe("error");
    expect(adminActionMocks.provisionInvitation).not.toHaveBeenCalled();
  });
});
