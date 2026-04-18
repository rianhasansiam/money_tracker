import { db } from "@/lib/db";
import { canManageTeamMembership } from "@/lib/roles";

export type TeamMembershipRoleValue = "ADMIN" | "MODARETOR" | "MEMBER";

export interface ApprovedTeamSummary {
  membershipId: string;
  teamId: string;
  name: string;
  description: string | null;
  role: TeamMembershipRoleValue;
  approvedAt: Date | null;
  memberCount: number;
  pendingRequestCount: number;
}

export interface PendingTeamRequestSummary {
  membershipId: string;
  teamId: string;
  name: string;
  description: string | null;
  requestedAt: Date;
}

export interface AvailableTeamSummary {
  teamId: string;
  name: string;
  description: string | null;
  creatorName: string | null;
  memberCount: number;
}

export interface AdminPendingApproval {
  membershipId: string;
  teamId: string;
  teamName: string;
  requesterName: string | null;
  requesterEmail: string | null;
  requestedAt: Date;
}

export interface GroupsPageData {
  approvedTeams: ApprovedTeamSummary[];
  pendingTeams: PendingTeamRequestSummary[];
  availableTeams: AvailableTeamSummary[];
  adminPendingApprovals: AdminPendingApproval[];
}

export async function getFirstApprovedTeamId(userId: string) {
  const memberships = await db.teamMembership.findMany({
    where: {
      userId,
      status: "APPROVED",
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      teamId: true,
      role: true,
      approvedAt: true,
    },
  });

  const firstMembership = memberships
    .slice()
    .sort((leftMembership, rightMembership) => {
      const leftRank = canManageTeamMembership(leftMembership.role) ? 1 : 0;
      const rightRank = canManageTeamMembership(rightMembership.role) ? 1 : 0;

      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }

      const leftApprovedAt = leftMembership.approvedAt?.getTime() ?? 0;
      const rightApprovedAt = rightMembership.approvedAt?.getTime() ?? 0;

      return leftApprovedAt - rightApprovedAt;
    })[0];

  return firstMembership?.teamId ?? null;
}

export async function getGroupsPageData(userId: string): Promise<GroupsPageData> {
  const memberships = await db.teamMembership.findMany({
    where: {
      userId,
    },
    orderBy: [
      {
        status: "asc",
      },
      {
        createdAt: "asc",
      },
    ],
    select: {
      id: true,
      teamId: true,
      role: true,
      status: true,
      approvedAt: true,
      createdAt: true,
      team: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
  });

  const joinedTeamIds = memberships.map((membership) => membership.teamId);

  const approvedCountGroups = await db.teamMembership.groupBy({
    by: ["teamId"],
    where: {
      status: "APPROVED",
    },
    _count: {
      _all: true,
    },
  });

  const pendingCountGroups = await db.teamMembership.groupBy({
    by: ["teamId"],
    where: {
      status: "PENDING",
    },
    _count: {
      _all: true,
    },
  });

  const approvedCounts = new Map(
    approvedCountGroups.map((entry) => [entry.teamId, entry._count._all]),
  );
  const pendingCounts = new Map(
    pendingCountGroups.map((entry) => [entry.teamId, entry._count._all]),
  );

  const availableTeams = await db.team.findMany({
    where: joinedTeamIds.length
      ? {
          id: {
            notIn: joinedTeamIds,
          },
        }
      : undefined,
    orderBy: [
      {
        name: "asc",
      },
    ],
    select: {
      id: true,
      name: true,
      description: true,
      createdBy: {
        select: {
          name: true,
        },
      },
    },
  });

  const adminPendingApprovals = await db.teamMembership.findMany({
    where: {
      status: "PENDING",
      team: {
        memberships: {
          some: {
            userId,
            status: "APPROVED",
            role: {
              in: ["ADMIN", "MODARETOR"],
            },
          },
        },
      },
    },
    orderBy: [
      {
        createdAt: "asc",
      },
    ],
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
          email: true,
        },
      },
    },
  });

  return {
    approvedTeams: memberships
      .filter((membership) => membership.status === "APPROVED")
      .map((membership) => ({
        membershipId: membership.id,
        teamId: membership.team.id,
        name: membership.team.name,
        description: membership.team.description,
        role: membership.role as TeamMembershipRoleValue,
        approvedAt: membership.approvedAt,
        memberCount: approvedCounts.get(membership.teamId) ?? 0,
        pendingRequestCount: pendingCounts.get(membership.teamId) ?? 0,
      })),
    pendingTeams: memberships
      .filter((membership) => membership.status === "PENDING")
      .map((membership) => ({
        membershipId: membership.id,
        teamId: membership.team.id,
        name: membership.team.name,
        description: membership.team.description,
        requestedAt: membership.createdAt,
      })),
    availableTeams: availableTeams.map((team) => ({
      teamId: team.id,
      name: team.name,
      description: team.description,
      creatorName: team.createdBy.name,
      memberCount: approvedCounts.get(team.id) ?? 0,
    })),
    adminPendingApprovals: adminPendingApprovals.map((membership) => ({
      membershipId: membership.id,
      teamId: membership.team.id,
      teamName: membership.team.name,
      requesterName: membership.user.name,
      requesterEmail: membership.user.email,
      requestedAt: membership.createdAt,
    })),
  };
}
