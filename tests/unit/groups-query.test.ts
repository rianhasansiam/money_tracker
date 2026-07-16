import { beforeEach, describe, expect, it, vi } from "vitest";

const groupsMocks = vi.hoisted(() => ({
  enforceUserRateLimit: vi.fn<() => Promise<unknown>>(),
  membershipFindFirst: vi.fn<(input: unknown) => Promise<unknown>>(),
  membershipFindMany: vi.fn<(input: unknown) => Promise<unknown>>(),
  teamFindFirst: vi.fn<(input: unknown) => Promise<unknown>>(),
  teamFindMany: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    teamMembership: {
      findFirst: groupsMocks.membershipFindFirst,
      findMany: groupsMocks.membershipFindMany,
    },
    team: {
      findFirst: groupsMocks.teamFindFirst,
      findMany: groupsMocks.teamFindMany,
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: groupsMocks.enforceUserRateLimit,
}));

import {
  AVAILABLE_TEAM_COLLECTION_LIMIT,
  GROUP_MEMBERSHIP_COLLECTION_LIMIT,
  PENDING_APPROVAL_COLLECTION_LIMIT,
  getFirstApprovedTeamId,
  getGroupsPageData,
  getRateLimitedGroupsPageData,
} from "@/lib/queries/groups";

function approvedMembership(index = 0) {
  return {
    id: `membership-${index}`,
    teamId: `team-${index}`,
    role: "ADMIN",
    status: "APPROVED",
    approvedAt: new Date("2026-07-15T01:00:00.000Z"),
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    team: {
      id: `team-${index}`,
      name: `Team ${index}`,
      description: "Shared costs",
      _count: {
        memberships: 2,
      },
    },
  };
}

describe("groups query DTOs and bounded reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupsMocks.enforceUserRateLimit.mockReset();
    groupsMocks.membershipFindFirst.mockReset();
    groupsMocks.membershipFindMany.mockReset();
    groupsMocks.teamFindFirst.mockReset();
    groupsMocks.teamFindMany.mockReset();
    groupsMocks.enforceUserRateLimit.mockResolvedValue({ allowed: true });
    groupsMocks.membershipFindMany
      .mockResolvedValueOnce([approvedMembership()])
      .mockResolvedValueOnce([
        {
          id: "request-1",
          createdAt: new Date("2026-07-15T02:00:00.000Z"),
          team: {
            id: "team-0",
            name: "Team 0",
          },
          user: {
            name: "Requesting Member",
            email: "must-not-be-serialized@example.test",
            id: "private-user-id",
          },
        },
      ]);
    groupsMocks.teamFindMany
      .mockResolvedValueOnce([
        {
          id: "team-0",
          _count: {
            memberships: 1,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "available-team",
          name: "Available Team",
          description: "Request access here",
          createdBy: {
            name: "must not be serialized",
            email: "creator@example.test",
          },
        },
      ]);
  });

  it("uses scoped relation counts and returns privacy-reviewed DTOs", async () => {
    const result = await getGroupsPageData("viewer-user-id");
    const serialized = JSON.stringify(result);
    const membershipQuery = groupsMocks.membershipFindMany.mock.calls[0]?.[0];
    const pendingApprovalQuery =
      groupsMocks.membershipFindMany.mock.calls[1]?.[0];
    const pendingCountQuery = groupsMocks.teamFindMany.mock.calls[0]?.[0];
    const availableQuery = groupsMocks.teamFindMany.mock.calls[1]?.[0];

    expect(membershipQuery).toEqual(
      expect.objectContaining({
        where: {
          userId: "viewer-user-id",
          status: {
            in: ["PENDING", "APPROVED"],
          },
          team: { deletedAt: null },
        },
        take: GROUP_MEMBERSHIP_COLLECTION_LIMIT + 1,
        select: expect.objectContaining({
          team: {
            select: expect.objectContaining({
              _count: {
                select: {
                  memberships: {
                    where: { status: "APPROVED" },
                  },
                },
              },
            }),
          },
        }),
      }),
    );
    expect(pendingCountQuery).toEqual(
      expect.objectContaining({
        where: {
          id: { in: ["team-0"] },
          deletedAt: null,
        },
      }),
    );
    expect(availableQuery).toEqual(
      expect.objectContaining({
        where: {
          deletedAt: null,
          memberships: {
            none: {
              userId: "viewer-user-id",
            },
          },
        },
        take: AVAILABLE_TEAM_COLLECTION_LIMIT + 1,
        select: {
          id: true,
          name: true,
          description: true,
        },
      }),
    );
    expect(pendingApprovalQuery).toEqual(
      expect.objectContaining({
        take: PENDING_APPROVAL_COLLECTION_LIMIT + 1,
        where: expect.objectContaining({
          team: expect.objectContaining({
            deletedAt: null,
            memberships: expect.anything(),
          }),
        }),
        select: expect.objectContaining({
          user: {
            select: {
              name: true,
            },
          },
        }),
      }),
    );
    expect(result.approvedTeams[0]).toMatchObject({
      memberCount: 2,
      pendingRequestCount: 1,
    });
    expect(result.availableTeams[0]).toEqual({
      teamId: "available-team",
      name: "Available Team",
      description: "Request access here",
    });
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain("private-user-id");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("creatorName");
  });

  it("caps every collection and reports truncation without global totals", async () => {
    groupsMocks.membershipFindMany.mockReset();
    groupsMocks.teamFindMany.mockReset();
    groupsMocks.membershipFindMany
      .mockResolvedValueOnce(
        Array.from(
          { length: GROUP_MEMBERSHIP_COLLECTION_LIMIT + 1 },
          (_, index) => approvedMembership(index),
        ),
      )
      .mockResolvedValueOnce(
        Array.from(
          { length: PENDING_APPROVAL_COLLECTION_LIMIT + 1 },
          (_, index) => ({
            id: `request-${index}`,
            createdAt: new Date("2026-07-15T02:00:00.000Z"),
            team: { id: `team-${index}`, name: `Team ${index}` },
            user: { name: null },
          }),
        ),
      );
    groupsMocks.teamFindMany
      .mockResolvedValueOnce(
        Array.from({ length: GROUP_MEMBERSHIP_COLLECTION_LIMIT }, (_, index) => ({
          id: `team-${index}`,
          _count: { memberships: 0 },
        })),
      )
      .mockResolvedValueOnce(
        Array.from(
          { length: AVAILABLE_TEAM_COLLECTION_LIMIT + 1 },
          (_, index) => ({
            id: `available-${index}`,
            name: `Available ${index}`,
            description: null,
          }),
        ),
      );

    const result = await getGroupsPageData("viewer-user-id");

    expect(result.approvedTeams).toHaveLength(
      GROUP_MEMBERSHIP_COLLECTION_LIMIT,
    );
    expect(result.availableTeams).toHaveLength(AVAILABLE_TEAM_COLLECTION_LIMIT);
    expect(result.adminPendingApprovals).toHaveLength(
      PENDING_APPROVAL_COLLECTION_LIMIT,
    );
    expect(result.truncated).toEqual({
      memberships: true,
      availableTeams: true,
      adminPendingApprovals: true,
    });
    expect(result.nextCursors).toEqual({
      memberships: `membership-${GROUP_MEMBERSHIP_COLLECTION_LIMIT - 1}`,
      availableTeams: `available-${AVAILABLE_TEAM_COLLECTION_LIMIT - 1}`,
      adminPendingApprovals: `request-${PENDING_APPROVAL_COLLECTION_LIMIT - 1}`,
    });
  });

  it("authorizes a cursor and supports a bounded next membership page", async () => {
    const cursor = "clh1234567890abcdefghijk";
    groupsMocks.membershipFindFirst.mockResolvedValueOnce({ id: cursor });
    groupsMocks.membershipFindMany.mockReset();
    groupsMocks.teamFindMany.mockReset();
    groupsMocks.membershipFindMany
      .mockResolvedValueOnce([approvedMembership(20), approvedMembership(21)])
      .mockResolvedValueOnce([]);
    groupsMocks.teamFindMany
      .mockResolvedValueOnce([
        { id: "team-20", _count: { memberships: 0 } },
        { id: "team-21", _count: { memberships: 0 } },
      ])
      .mockResolvedValueOnce([]);

    const result = await getGroupsPageData("viewer-user-id", {
      memberships: cursor,
    });

    expect(result?.approvedTeams).toHaveLength(2);
    expect(result?.nextCursors.memberships).toBeNull();
    expect(groupsMocks.membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: cursor },
        skip: 1,
        take: GROUP_MEMBERSHIP_COLLECTION_LIMIT + 1,
      }),
    );
  });

  it("rejects a malformed, unknown, or cross-scope cursor before page reads", async () => {
    await expect(
      getGroupsPageData("viewer-user-id", { memberships: "tampered" }),
    ).resolves.toBeNull();
    expect(groupsMocks.membershipFindMany).not.toHaveBeenCalled();

    const cursor = "clh1234567890abcdefghijk";
    groupsMocks.membershipFindFirst.mockResolvedValueOnce(null);

    await expect(
      getGroupsPageData("viewer-user-id", { memberships: cursor }),
    ).resolves.toBeNull();
    expect(groupsMocks.membershipFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty final page without manufacturing another cursor", async () => {
    const cursor = "clh1234567890abcdefghijk";
    groupsMocks.membershipFindFirst.mockResolvedValueOnce({ id: cursor });
    groupsMocks.membershipFindMany.mockReset();
    groupsMocks.teamFindMany.mockReset();
    groupsMocks.membershipFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    groupsMocks.teamFindMany.mockResolvedValueOnce([]);

    const result = await getGroupsPageData("viewer-user-id", {
      memberships: cursor,
    });

    expect(result).toMatchObject({
      approvedTeams: [],
      pendingTeams: [],
      nextCursors: { memberships: null },
    });
  });

  it("prefers one managed approved team without loading all memberships", async () => {
    groupsMocks.membershipFindFirst.mockResolvedValueOnce({ teamId: "managed" });

    await expect(getFirstApprovedTeamId("viewer-user-id")).resolves.toBe(
      "managed",
    );
    expect(groupsMocks.membershipFindFirst).toHaveBeenCalledTimes(1);
  });

  it("rate-limits team enumeration before running queries", async () => {
    await getRateLimitedGroupsPageData("viewer-user-id");

    expect(groupsMocks.enforceUserRateLimit).toHaveBeenCalledWith({
      scope: "team-enumeration",
      userId: "viewer-user-id",
      limit: 45,
      windowSeconds: 60,
    });
  });
});
