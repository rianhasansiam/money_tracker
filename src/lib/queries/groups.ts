import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { canManageTeamMembership } from "@/lib/roles";
import { collectionCursorSchema } from "@/lib/validators/pagination";

export const GROUP_MEMBERSHIP_COLLECTION_LIMIT = 20;
export const AVAILABLE_TEAM_COLLECTION_LIMIT = 20;
export const PENDING_APPROVAL_COLLECTION_LIMIT = 20;

export type TeamMembershipRoleValue = "ADMIN" | "MODERATOR" | "MEMBER";

interface ApprovedTeamSummaryDto {
  teamId: string;
  name: string;
  description: string | null;
  role: TeamMembershipRoleValue;
  memberCount: number;
  pendingRequestCount: number;
}

interface PendingTeamRequestSummaryDto {
  teamId: string;
  name: string;
  description: string | null;
  requestedAt: string;
}

/** Minimum public team metadata needed for a nonmember to request access. */
interface AvailableTeamSummaryDto {
  teamId: string;
  name: string;
  description: string | null;
}

/** Requester email and account identifiers are intentionally excluded. */
interface AdminPendingApprovalDto {
  membershipId: string;
  teamId: string;
  teamName: string;
  requesterName: string | null;
  requestedAt: string;
}

export interface GroupsPageDataDto {
  approvedTeams: ApprovedTeamSummaryDto[];
  pendingTeams: PendingTeamRequestSummaryDto[];
  availableTeams: AvailableTeamSummaryDto[];
  adminPendingApprovals: AdminPendingApprovalDto[];
  truncated: {
    memberships: boolean;
    availableTeams: boolean;
    adminPendingApprovals: boolean;
  };
  nextCursors: {
    memberships: string | null;
    availableTeams: string | null;
    adminPendingApprovals: string | null;
  };
}

export interface GroupsPageCursors {
  memberships?: string;
  availableTeams?: string;
  adminPendingApprovals?: string;
}

function parseCursor(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = collectionCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getFirstApprovedTeamId(userId: string) {
  const managedMembership = await db.teamMembership.findFirst({
    where: {
      userId,
      status: "APPROVED",
      role: {
        in: ["ADMIN", "MODERATOR"],
      },
      team: {
        deletedAt: null,
      },
    },
    orderBy: [
      {
        approvedAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      teamId: true,
    },
  });

  if (managedMembership) {
    return managedMembership.teamId;
  }

  const memberMembership = await db.teamMembership.findFirst({
    where: {
      userId,
      status: "APPROVED",
      team: {
        deletedAt: null,
      },
    },
    orderBy: [
      {
        approvedAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      teamId: true,
    },
  });

  return memberMembership?.teamId ?? null;
}

export function getGroupsPageData(
  userId: string,
): Promise<GroupsPageDataDto>;
export function getGroupsPageData(
  userId: string,
  cursors: GroupsPageCursors,
): Promise<GroupsPageDataDto | null>;
export async function getGroupsPageData(
  userId: string,
  cursors: GroupsPageCursors = {},
): Promise<GroupsPageDataDto | null> {
  if (!userId || userId.length > 191) {
    return null;
  }

  const membershipCursor = parseCursor(cursors.memberships);
  const availableTeamCursor = parseCursor(cursors.availableTeams);
  const adminPendingApprovalCursor = parseCursor(
    cursors.adminPendingApprovals,
  );

  if (
    membershipCursor === null ||
    availableTeamCursor === null ||
    adminPendingApprovalCursor === null
  ) {
    return null;
  }

  const membershipWhere: Prisma.TeamMembershipWhereInput = {
    userId,
    status: {
      in: ["PENDING", "APPROVED"],
    },
    team: {
      deletedAt: null,
    },
  };
  const availableTeamWhere: Prisma.TeamWhereInput = {
    deletedAt: null,
    memberships: {
      none: {
        userId,
      },
    },
  };
  const adminPendingApprovalWhere: Prisma.TeamMembershipWhereInput = {
    status: "PENDING",
    team: {
      deletedAt: null,
      memberships: {
        some: {
          userId,
          status: "APPROVED",
          role: {
            in: ["ADMIN", "MODERATOR"],
          },
        },
      },
    },
  };

  const [authorizedMembershipCursor, authorizedAvailableTeamCursor, authorizedApprovalCursor] =
    await Promise.all([
      membershipCursor
        ? db.teamMembership.findFirst({
            where: { ...membershipWhere, id: membershipCursor },
            select: { id: true },
          })
        : Promise.resolve(undefined),
      availableTeamCursor
        ? db.team.findFirst({
            where: { ...availableTeamWhere, id: availableTeamCursor },
            select: { id: true },
          })
        : Promise.resolve(undefined),
      adminPendingApprovalCursor
        ? db.teamMembership.findFirst({
            where: {
              ...adminPendingApprovalWhere,
              id: adminPendingApprovalCursor,
            },
            select: { id: true },
          })
        : Promise.resolve(undefined),
    ]);

  if (
    (membershipCursor && !authorizedMembershipCursor) ||
    (availableTeamCursor && !authorizedAvailableTeamCursor) ||
    (adminPendingApprovalCursor && !authorizedApprovalCursor)
  ) {
    return null;
  }

  const membershipsWithSentinel = await db.teamMembership.findMany({
    where: membershipWhere,
    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    ...(authorizedMembershipCursor
      ? { cursor: { id: authorizedMembershipCursor.id }, skip: 1 }
      : {}),
    take: GROUP_MEMBERSHIP_COLLECTION_LIMIT + 1,
    select: {
      id: true,
      teamId: true,
      role: true,
      status: true,
      createdAt: true,
      team: {
        select: {
          id: true,
          name: true,
          description: true,
          _count: {
            select: {
              memberships: {
                where: {
                  status: "APPROVED",
                },
              },
            },
          },
        },
      },
    },
  });
  const memberships = membershipsWithSentinel.slice(
    0,
    GROUP_MEMBERSHIP_COLLECTION_LIMIT,
  );
  const managedTeamIds = memberships
    .filter(
      (membership) =>
        membership.status === "APPROVED" &&
        canManageTeamMembership(membership.role),
    )
    .map((membership) => membership.teamId);

  const pendingCounts =
    managedTeamIds.length === 0
      ? []
      : await db.team.findMany({
          where: {
            id: {
              in: managedTeamIds,
            },
            deletedAt: null,
          },
          select: {
            id: true,
            _count: {
              select: {
                memberships: {
                  where: {
                    status: "PENDING",
                  },
                },
              },
            },
          },
        });
  const pendingCountByTeamId = new Map(
    pendingCounts.map((team) => [team.id, team._count.memberships]),
  );

  const availableTeamsWithSentinel = await db.team.findMany({
    where: availableTeamWhere,
    orderBy: [
      {
        name: "asc",
      },
      {
        id: "asc",
      },
    ],
    ...(authorizedAvailableTeamCursor
      ? { cursor: { id: authorizedAvailableTeamCursor.id }, skip: 1 }
      : {}),
    take: AVAILABLE_TEAM_COLLECTION_LIMIT + 1,
    select: {
      id: true,
      name: true,
      description: true,
    },
  });
  const availableTeams = availableTeamsWithSentinel.slice(
    0,
    AVAILABLE_TEAM_COLLECTION_LIMIT,
  );

  const adminPendingApprovalsWithSentinel = await db.teamMembership.findMany({
    where: adminPendingApprovalWhere,
    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    ...(authorizedApprovalCursor
      ? { cursor: { id: authorizedApprovalCursor.id }, skip: 1 }
      : {}),
    take: PENDING_APPROVAL_COLLECTION_LIMIT + 1,
    select: {
      id: true,
      createdAt: true,
      team: {
        select: {
          id: true,
          name: true,
        },
      },
      user: {
        select: {
          name: true,
        },
      },
    },
  });
  const adminPendingApprovals = adminPendingApprovalsWithSentinel.slice(
    0,
    PENDING_APPROVAL_COLLECTION_LIMIT,
  );

  return {
    approvedTeams: memberships
      .filter((membership) => membership.status === "APPROVED")
      .map((membership) => ({
        teamId: membership.team.id,
        name: membership.team.name,
        description: membership.team.description,
        role: membership.role as TeamMembershipRoleValue,
        memberCount: membership.team._count.memberships,
        pendingRequestCount:
          pendingCountByTeamId.get(membership.teamId) ?? 0,
      })),
    pendingTeams: memberships
      .filter((membership) => membership.status === "PENDING")
      .map((membership) => ({
        teamId: membership.team.id,
        name: membership.team.name,
        description: membership.team.description,
        requestedAt: membership.createdAt.toISOString(),
      })),
    availableTeams: availableTeams.map((team) => ({
      teamId: team.id,
      name: team.name,
      description: team.description,
    })),
    adminPendingApprovals: adminPendingApprovals.map((membership) => ({
      membershipId: membership.id,
      teamId: membership.team.id,
      teamName: membership.team.name,
      requesterName: membership.user.name,
      requestedAt: membership.createdAt.toISOString(),
    })),
    truncated: {
      memberships:
        membershipsWithSentinel.length > GROUP_MEMBERSHIP_COLLECTION_LIMIT,
      availableTeams:
        availableTeamsWithSentinel.length > AVAILABLE_TEAM_COLLECTION_LIMIT,
      adminPendingApprovals:
        adminPendingApprovalsWithSentinel.length >
        PENDING_APPROVAL_COLLECTION_LIMIT,
    },
    nextCursors: {
      memberships:
        membershipsWithSentinel.length > GROUP_MEMBERSHIP_COLLECTION_LIMIT
          ? memberships.at(-1)?.id ?? null
          : null,
      availableTeams:
        availableTeamsWithSentinel.length > AVAILABLE_TEAM_COLLECTION_LIMIT
          ? availableTeams.at(-1)?.id ?? null
          : null,
      adminPendingApprovals:
        adminPendingApprovalsWithSentinel.length >
        PENDING_APPROVAL_COLLECTION_LIMIT
          ? adminPendingApprovals.at(-1)?.id ?? null
          : null,
    },
  };
}

export async function getRateLimitedGroupsPageData(
  userId: string,
  cursors: GroupsPageCursors = {},
) {
  await enforceUserRateLimit({
    scope: "team-enumeration",
    userId,
    limit: 45,
    windowSeconds: 60,
  });

  return getGroupsPageData(userId, cursors);
}
