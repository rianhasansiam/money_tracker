import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const adminWorkflowMocks = vi.hoisted(() => ({
  db: {},
  enforceUserRateLimit: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/db", () => ({
  db: adminWorkflowMocks.db,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: adminWorkflowMocks.enforceUserRateLimit,
}));

import {
  ADMIN_INVITATION_LIMIT,
  ADMIN_TEAM_LIMIT,
  ADMIN_TEAM_MEMBER_LIMIT,
  ADMIN_USER_LIMIT,
  createPrismaAdminWorkflowRepository,
  getRateLimitedAdminConsoleData,
} from "@/lib/admin-workflows";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const CORRELATION_ID = "4f635d30-b641-4944-b66f-c3beac114f8a";
const TEAM_ID = "clh1234567890abcdefghijk";

function activeAdministrator() {
  return {
    id: "administrator-internal-id",
    name: "Security Admin",
    role: "ADMIN" as const,
    status: "ACTIVE" as const,
    lastAuthenticatedAt: new Date("2026-07-15T09:55:00.000Z"),
    disabledAt: null,
    deletedAt: null,
  };
}

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-internal-id",
    name: "Target User",
    email: "target@example.com",
    role: "MEMBER" as const,
    status: "ACTIVE" as const,
    disabledAt: null,
    deletedAt: null,
    _count: {
      createdTeams: 0,
    },
    ...overrides,
  };
}

function transactionClient() {
  return {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(activeAdministrator()),
      findMany: vi.fn().mockResolvedValue([activeTarget()]),
      count: vi.fn().mockResolvedValue(2),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    invitation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    team: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    teamMembership: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    session: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({
        id: "audit-internal-id",
        createdAt: NOW,
      }),
    },
  };
}

function repository(tx: ReturnType<typeof transactionClient>) {
  const database = {
    $transaction: vi.fn(
      async (
        operation: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => operation(tx as unknown as Prisma.TransactionClient),
    ),
  };

  return {
    database,
    workflows: createPrismaAdminWorkflowRepository(
      database as unknown as Parameters<
        typeof createPrismaAdminWorkflowRepository
      >[0],
    ),
  };
}

describe("authorized administrative workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminWorkflowMocks.enforceUserRateLimit.mockReset();
  });

  it("returns a bounded explicit DTO without user, membership, or invitation IDs", async () => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue([
      {
        id: "must-not-leave-the-dal",
        name: "Visible User",
        email: "visible@example.com",
        role: "MEMBER",
        status: "ACTIVE",
        _count: { createdTeams: 0 },
      },
    ]);
    tx.invitation.findMany.mockResolvedValue([
      {
        id: "hidden-invitation-id",
        email: "invited@example.com",
        status: "PENDING",
        expiresAt: new Date("2026-07-22T10:00:00.000Z"),
      },
    ]);
    tx.team.findMany.mockResolvedValue([
      {
        id: TEAM_ID,
        name: "Treasury",
        deletedAt: null,
        purgeAfter: null,
        createdBy: { email: "owner@example.com" },
        memberships: [
          {
            id: "hidden-membership-id",
            role: "MEMBER",
            status: "APPROVED",
            user: {
              id: "hidden-member-user-id",
              name: "Visible Member",
              email: "member@example.com",
            },
          },
        ],
      },
    ]);
    const { workflows } = repository(tx);

    const result = await workflows.getConsoleData("administrator-internal-id");
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      viewerName: "Security Admin",
      users: [{ email: "visible@example.com" }],
      teams: [{ teamId: TEAM_ID, ownerEmail: "owner@example.com" }],
    });
    expect(serialized).not.toContain("must-not-leave-the-dal");
    expect(serialized).not.toContain("hidden-invitation-id");
    expect(serialized).not.toContain("hidden-membership-id");
    expect(serialized).not.toContain("hidden-member-user-id");
    expect(serialized).not.toContain("sessionToken");
    expect(serialized).not.toContain("access_token");
  });

  it("applies one bounded server-side search across administrative collections", async () => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue([]);
    tx.invitation.findMany.mockResolvedValue([]);
    tx.team.findMany.mockResolvedValue([]);
    const { workflows } = repository(tx);

    await workflows.getConsoleData(
      "administrator-internal-id",
      "  target@example.com  ",
    );

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.any(Array),
        }),
        take: ADMIN_USER_LIMIT + 1,
      }),
    );
    expect(tx.invitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: {
            contains: "target@example.com",
            mode: "insensitive",
          },
        },
        take: ADMIN_INVITATION_LIMIT + 1,
      }),
    );
    expect(tx.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: ADMIN_TEAM_LIMIT + 1,
      }),
    );
  });

  it("emits a stable next cursor for every bounded administration collection", async () => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue(
      Array.from({ length: ADMIN_USER_LIMIT + 1 }, (_, index) => ({
        name: `User ${index}`,
        email: `user-${String(index).padStart(3, "0")}@example.test`,
        role: "MEMBER",
        status: "ACTIVE",
        _count: { createdTeams: 0 },
      })),
    );
    tx.invitation.findMany.mockResolvedValue(
      Array.from({ length: ADMIN_INVITATION_LIMIT + 1 }, (_, index) => ({
        email: `invite-${String(index).padStart(3, "0")}@example.test`,
        status: "PENDING",
        expiresAt: NOW,
      })),
    );
    tx.team.findMany.mockResolvedValue(
      Array.from({ length: ADMIN_TEAM_LIMIT + 1 }, (_, index) => ({
        id: `clh${String(index).padStart(22, "0")}`,
        name: `Team ${index}`,
        deletedAt: null,
        purgeAfter: null,
        createdBy: { email: "owner@example.test" },
        memberships: [],
      })),
    );
    const { workflows } = repository(tx);

    const result = await workflows.getConsoleData("administrator-internal-id");

    expect(result?.users).toHaveLength(ADMIN_USER_LIMIT);
    expect(result?.invitations).toHaveLength(ADMIN_INVITATION_LIMIT);
    expect(result?.teams).toHaveLength(ADMIN_TEAM_LIMIT);
    expect(result?.nextCursors).toEqual({
      users: `user-${String(ADMIN_USER_LIMIT - 1).padStart(3, "0")}@example.test`,
      invitations: `invite-${String(ADMIN_INVITATION_LIMIT - 1).padStart(3, "0")}@example.test`,
      teams: `clh${String(ADMIN_TEAM_LIMIT - 1).padStart(22, "0")}`,
    });
  });

  it("authorizes cursors and returns an empty final administration page", async () => {
    const tx = transactionClient();
    const cursor = "cursor@example.test";
    tx.user.findFirst
      .mockResolvedValueOnce({ name: "Security Admin" })
      .mockResolvedValueOnce({ email: cursor });
    tx.user.findMany.mockResolvedValue([]);
    tx.invitation.findMany.mockResolvedValue([]);
    tx.team.findMany.mockResolvedValue([]);
    const { workflows } = repository(tx);

    const result = await workflows.getConsoleData(
      "administrator-internal-id",
      undefined,
      { users: cursor },
    );

    expect(result?.users).toEqual([]);
    expect(result?.nextCursors.users).toBeNull();
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { email: cursor },
        skip: 1,
        take: ADMIN_USER_LIMIT + 1,
      }),
    );
  });

  it("rejects cursor tampering and unauthorized administration reads", async () => {
    const tx = transactionClient();
    tx.user.findFirst
      .mockResolvedValueOnce({ name: "Security Admin" })
      .mockResolvedValueOnce(null);
    const { workflows } = repository(tx);

    await expect(
      workflows.getConsoleData("administrator-internal-id", undefined, {
        users: "outside-filter@example.test",
      }),
    ).resolves.toBeNull();
    expect(tx.user.findMany).not.toHaveBeenCalled();

    const unauthorizedTx = transactionClient();
    unauthorizedTx.user.findFirst.mockResolvedValueOnce(null);
    const unauthorized = repository(unauthorizedTx).workflows;

    await expect(
      unauthorized.getConsoleData("non-administrator-id"),
    ).resolves.toBeNull();
    expect(unauthorizedTx.user.findMany).not.toHaveBeenCalled();
  });

  it("paginates each team's member collection without exposing a membership ID", async () => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue([]);
    tx.invitation.findMany.mockResolvedValue([]);
    tx.team.findMany.mockResolvedValue([
      {
        id: TEAM_ID,
        name: "Treasury",
        deletedAt: null,
        purgeAfter: null,
        createdBy: { email: "owner@example.test" },
        memberships: Array.from(
          { length: ADMIN_TEAM_MEMBER_LIMIT + 1 },
          (_, index) => ({
            id: `hidden-membership-${index}`,
            role: "MEMBER",
            status: "APPROVED",
            user: {
              name: `Member ${index}`,
              email: `member-${String(index).padStart(3, "0")}@example.test`,
            },
          }),
        ),
      },
    ]);
    const { workflows } = repository(tx);

    const result = await workflows.getConsoleData("administrator-internal-id");
    const team = result?.teams[0];

    expect(team?.members).toHaveLength(ADMIN_TEAM_MEMBER_LIMIT);
    expect(team?.nextMemberCursor).toBe(
      `member-${String(ADMIN_TEAM_MEMBER_LIMIT - 1).padStart(3, "0")}@example.test`,
    );
    expect(JSON.stringify(result)).not.toContain("hidden-membership-");
  });

  it("rate-limits administration collection reads before repository access", async () => {
    const limiterFailure = new Error("synthetic durable limiter rejection");
    adminWorkflowMocks.enforceUserRateLimit.mockRejectedValueOnce(limiterFailure);

    await expect(
      getRateLimitedAdminConsoleData("administrator-internal-id"),
    ).rejects.toBe(limiterFailure);
    expect(adminWorkflowMocks.enforceUserRateLimit).toHaveBeenCalledWith({
      scope: "admin-collection-read",
      userId: "administrator-internal-id",
      limit: 30,
      windowSeconds: 60,
    });
  });

  it.each(["accounts", "invitations", "access", "recovery"] as const)("loads only the selected %s collection", async (view) => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue([]);
    tx.invitation.findMany.mockResolvedValue([]);
    tx.team.findMany.mockResolvedValue([]);
    const { workflows } = repository(tx);
    const result = await workflows.getConsoleData("administrator-internal-id", undefined, {}, view);
    expect(result).not.toBeNull();
    expect(tx.user.findMany).toHaveBeenCalledTimes(view === "accounts" ? 1 : 0);
    expect(tx.invitation.findMany).toHaveBeenCalledTimes(view === "invitations" ? 1 : 0);
    expect(tx.team.findMany).toHaveBeenCalledTimes(view === "access" || view === "recovery" ? 1 : 0);
    expect(tx.teamMembership.findMany).not.toHaveBeenCalled();
    if (view === "recovery") expect(tx.team.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: { not: null } }),
      select: expect.objectContaining({ memberships: undefined }),
    }));
    if (view === "access") expect(tx.team.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }));
  });

  it("ignores hidden-task cursors and retains live authorization for selected reads", async () => {
    const tx = transactionClient();
    tx.user.findFirst.mockResolvedValue({ name: "Security Admin" });
    tx.user.findMany.mockResolvedValue([]);
    const result = await repository(tx).workflows.getConsoleData("administrator-internal-id", undefined, { invitations: "malformed", teams: "invalid" }, "accounts");
    expect(result?.users).toEqual([]);
    expect(tx.invitation.findFirst).not.toHaveBeenCalled();
    expect(tx.team.findFirst).not.toHaveBeenCalled();
    const denied = transactionClient();
    denied.user.findFirst.mockResolvedValue(null);
    expect(await repository(denied).workflows.getConsoleData("member-id", undefined, {}, "invitations")).toBeNull();
    expect(denied.invitation.findMany).not.toHaveBeenCalled();
  });

  it("disables an active non-owner and atomically revokes sessions and audits", async () => {
    const tx = transactionClient();
    const { workflows } = repository(tx);

    const result = await workflows.setUserEnabled({
      actorUserId: "administrator-internal-id",
      email: "Target@Example.com",
      enabled: false,
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({
      status: "changed",
      revokedSessionCount: 2,
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "DISABLED",
          disabledAt: NOW,
        },
      }),
    );
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "target-internal-id" },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "user.disabled",
          correlationId: CORRELATION_ID,
          targetIdSnapshot: "target-internal-id",
        }),
      }),
    );
  });

  it("requires ownership transfer before disabling an owner", async () => {
    const tx = transactionClient();
    tx.user.findMany.mockResolvedValue([
      activeTarget({ _count: { createdTeams: 1 } }),
    ]);
    const { workflows } = repository(tx);

    const result = await workflows.setUserEnabled({
      actorUserId: "administrator-internal-id",
      email: "target@example.com",
      enabled: false,
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({ status: "ownership_transfer_required" });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the last active global administrator in place", async () => {
    const tx = transactionClient();
    tx.user.findMany.mockResolvedValue([
      activeTarget({ role: "ADMIN", id: "administrator-internal-id" }),
    ]);
    tx.user.count.mockResolvedValue(1);
    const { workflows } = repository(tx);

    const result = await workflows.setGlobalRole({
      actorUserId: "administrator-internal-id",
      email: "target@example.com",
      role: "MEMBER",
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({ status: "last_admin_required" });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });

  it("allows an owner to be demoted globally while preserving separate team ownership", async () => {
    const tx = transactionClient();
    tx.user.findMany.mockResolvedValue([
      activeTarget({ role: "ADMIN", _count: { createdTeams: 1 } }),
    ]);
    tx.user.count.mockResolvedValue(2);
    const { workflows } = repository(tx);

    const result = await workflows.setGlobalRole({
      actorUserId: "administrator-internal-id",
      email: "target@example.com",
      role: "MEMBER",
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result.status).toBe("changed");
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "MEMBER" } }),
    );
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "target-internal-id" },
    });
  });

  it("re-enables only a disabled account and still revokes stale sessions", async () => {
    const tx = transactionClient();
    tx.user.findMany.mockResolvedValue([
      activeTarget({
        status: "DISABLED",
        disabledAt: new Date("2026-07-14T10:00:00.000Z"),
      }),
    ]);
    const { workflows } = repository(tx);

    const result = await workflows.setUserEnabled({
      actorUserId: "administrator-internal-id",
      email: "target@example.com",
      enabled: true,
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result.status).toBe("changed");
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "ACTIVE",
          disabledAt: null,
        },
      }),
    );
    expect(tx.session.deleteMany).toHaveBeenCalled();
    expect(tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.enabled" }),
      }),
    );
  });

  it("refuses to revoke an owner's membership until ownership moves", async () => {
    const tx = transactionClient();
    tx.team.findFirst.mockResolvedValue({
      id: TEAM_ID,
      createdById: "target-internal-id",
    });
    const { workflows } = repository(tx);

    const result = await workflows.revokeMembership({
      actorUserId: "administrator-internal-id",
      teamId: TEAM_ID,
      email: "target@example.com",
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({ status: "ownership_transfer_required" });
    expect(tx.teamMembership.updateMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes membership status and the affected account's sessions", async () => {
    const tx = transactionClient();
    tx.team.findFirst.mockResolvedValue({
      id: TEAM_ID,
      createdById: "different-owner-id",
    });
    tx.teamMembership.findUnique.mockResolvedValue({
      id: "membership-internal-id",
      status: "APPROVED",
    });
    const { workflows } = repository(tx);

    const result = await workflows.revokeMembership({
      actorUserId: "administrator-internal-id",
      teamId: TEAM_ID,
      email: "target@example.com",
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result.status).toBe("changed");
    expect(tx.teamMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "REVOKED",
          approvedAt: null,
          approvedById: null,
        },
      }),
    );
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "target-internal-id" },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "team.membership_revoked",
          teamIdSnapshot: TEAM_ID,
          metadata: expect.objectContaining({
            subjectIdSnapshot: "target-internal-id",
          }),
        }),
      }),
    );
  });

  it("transfers ownership only to an active approved member and revokes both owners' sessions", async () => {
    const tx = transactionClient();
    tx.team.findFirst.mockResolvedValue({
      id: TEAM_ID,
      name: "Treasury",
      createdById: "previous-owner-id",
    });
    tx.teamMembership.findUnique.mockResolvedValue({
      id: "membership-internal-id",
      role: "MEMBER",
      status: "APPROVED",
    });
    const { workflows } = repository(tx);

    const result = await workflows.transferOwnership({
      actorUserId: "administrator-internal-id",
      teamId: TEAM_ID,
      newOwnerEmail: "target@example.com",
      confirmedTeamName: "Treasury",
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result.status).toBe("changed");
    expect(tx.teamMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "ADMIN" } }),
    );
    expect(tx.team.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { createdById: "target-internal-id" } }),
    );
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: {
          in: ["previous-owner-id", "target-internal-id"],
        },
      },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "team.ownership_transferred",
          metadata: expect.objectContaining({
            previousOwnerIdSnapshot: "previous-owner-id",
            newOwnerIdSnapshot: "target-internal-id",
          }),
        }),
      }),
    );
  });

  it("requires a fresh authentication before any mutation", async () => {
    const tx = transactionClient();
    tx.user.findUnique.mockResolvedValue({
      ...activeAdministrator(),
      lastAuthenticatedAt: new Date("2026-07-15T09:00:00.000Z"),
    });
    const { workflows } = repository(tx);

    const result = await workflows.setUserEnabled({
      actorUserId: "administrator-internal-id",
      email: "target@example.com",
      enabled: false,
      now: NOW,
      correlationId: CORRELATION_ID,
    });

    expect(result).toEqual({ status: "recent_authentication_required" });
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
});
