import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canCreateOrDeleteGroups,
  canManageTeamMembership,
  formatRoleLabel,
} from "@/lib/roles";
import { isActiveUserState } from "@/lib/security-policy";

const groupActionMocks = vi.hoisted(() => {
  class RateLimitExceededError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("Rate limit exceeded.");
    }
  }

  class RateLimitUnavailableError extends Error {}
  class TeamLifecycleConflictError extends Error {}

  return {
    auth: vi.fn<
      () =>
        Promise<{
          user: {
            id: string;
            role: "ADMIN" | "MODERATOR" | "MEMBER";
          };
        } | null>
    >(),
    enforceUserRateLimit: vi.fn(),
    quarantineTeam: vi.fn(),
    RateLimitExceededError,
    RateLimitUnavailableError,
    recordAuditEvent: vi.fn(),
    revalidatePath: vi.fn(),
    reportUnexpectedError: vi.fn(() => ({
      correlationId: "00000000-0000-4000-8000-000000000001",
      message: "The request could not be completed.",
    })),
    TeamLifecycleConflictError,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: groupActionMocks.revalidatePath,
}));

vi.mock("@/lib/audit-events", () => ({
  recordAuditEvent: groupActionMocks.recordAuditEvent,
}));

vi.mock("@/lib/auth", () => ({
  auth: groupActionMocks.auth,
}));

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@/lib/observability", () => ({
  SERVER_ERROR_CATEGORY: {
    dataAccess: "data_access",
    lifecycle: "lifecycle",
  },
  createCorrelationId: vi.fn(
    () => "00000000-0000-4000-8000-000000000001",
  ),
  reportUnexpectedError: groupActionMocks.reportUnexpectedError,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: groupActionMocks.enforceUserRateLimit,
  RateLimitExceededError: groupActionMocks.RateLimitExceededError,
  RateLimitUnavailableError: groupActionMocks.RateLimitUnavailableError,
}));

vi.mock("@/lib/team-lifecycle", () => ({
  quarantineTeam: groupActionMocks.quarantineTeam,
  TeamLifecycleConflictError: groupActionMocks.TeamLifecycleConflictError,
}));

import {
  approveTeamAccess,
  createTeam,
  quarantineTeamAction,
  requestTeamAccess,
} from "@/actions/groups";

const VALID_CUID = "clh1234567890abcdefghijk";
const EXPIRED_SESSION_RESULT = {
  status: "error",
  message: "Your session has expired. Please sign in again.",
};

describe("global and team authorization matrix", () => {
  it.each([
    ["ADMIN", true, true, "Admin"],
    ["MODERATOR", false, true, "Moderator"],
    ["MEMBER", false, false, "Member"],
    [null, false, false, "Member"],
    [undefined, false, false, "Member"],
    ["UNRECOGNIZED", false, false, "Member"],
  ] as const)(
    "maps %s without allowing a global role to bypass team authority",
    (role, canManageGroups, canManageLedger, label) => {
      expect(canCreateOrDeleteGroups(role)).toBe(canManageGroups);
      expect(canManageTeamMembership(role)).toBe(canManageLedger);
      expect(formatRoleLabel(role)).toBe(label);
    },
  );

  it.each([
    ["active", { status: "ACTIVE", disabledAt: null, deletedAt: null }, true],
    ["pending", { status: "PENDING", disabledAt: null, deletedAt: null }, false],
    ["disabled status", { status: "DISABLED", disabledAt: null, deletedAt: null }, false],
    ["disabled timestamp", { status: "ACTIVE", disabledAt: new Date(), deletedAt: null }, false],
    ["deleted status", { status: "DELETED", disabledAt: null, deletedAt: null }, false],
    ["deleted timestamp", { status: "ACTIVE", disabledAt: null, deletedAt: new Date() }, false],
  ] as const)("recognizes the %s account state", (_label, state, expected) => {
    expect(isActiveUserState(state)).toBe(expected);
  });
});

describe("group Server Action authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupActionMocks.auth.mockResolvedValue(null);
  });

  it.each([
    ["team creation", () => createTeam({ name: "Treasury", description: "" })],
    ["team quarantine", () => quarantineTeamAction(VALID_CUID, "Treasury")],
    ["membership request", () => requestTeamAccess(VALID_CUID)],
    ["membership approval", () => approveTeamAccess(VALID_CUID)],
  ])("rejects anonymous %s before rate-limit or database work", async (_label, invoke) => {
    await expect(invoke()).resolves.toEqual(EXPIRED_SESSION_RESULT);
    expect(groupActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(groupActionMocks.quarantineTeam).not.toHaveBeenCalled();
    expect(groupActionMocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "MODERATOR"] as const)(
    "does not treat a global %s as a global administrator for team creation",
    async (role) => {
      groupActionMocks.auth.mockResolvedValue({
        user: { id: `global-${role.toLowerCase()}`, role },
      });

      await expect(
        createTeam({ name: "Treasury", description: "" }),
      ).resolves.toEqual({
        status: "error",
        message:
          "This team request cannot be processed. Refresh the page and try again.",
      });
      expect(groupActionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
      expect(groupActionMocks.recordAuditEvent).not.toHaveBeenCalled();
    },
  );
});
