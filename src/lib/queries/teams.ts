import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { TeamMembershipRoleValue } from "@/lib/queries/groups";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { collectionCursorSchema } from "@/lib/validators/pagination";
import { teamIdSchema } from "@/lib/validators/team";
import { teamsViewSchema, type TeamsView, type TeamsViewCursors } from "@/lib/validators/teams-view";

export const TEAM_TASK_PAGE_SIZE = 20;

export interface ApprovedTeamOptionDto {
  teamId: string;
  name: string;
  description: string | null;
  teamRole: TeamMembershipRoleValue;
  isOwner: boolean;
}
export interface ApprovedTeamsPageDto {
  teams: ApprovedTeamOptionDto[];
  nextCursor: string | null;
}
interface PendingTeamDto {
  teamId: string;
  name: string;
  description: string | null;
  requestedAt: string;
}
interface DiscoverableTeamDto {
  teamId: string;
  name: string;
  description: string | null;
}
interface IncomingTeamRequestDto {
  membershipId: string;
  teamName: string;
  requesterName: string | null;
  requestedAt: string;
}
export interface TeamsWorkspaceDto {
  view: TeamsView;
  globalRole: string;
  hasApprovedTeams: boolean;
  hasPendingRequests: boolean;
  canReviewRequests: boolean;
  hasIncomingRequests: boolean;
  approvedTeams: ApprovedTeamOptionDto[];
  discoverableTeams: DiscoverableTeamDto[];
  pendingRequests: PendingTeamDto[];
  incomingRequests: IncomingTeamRequestDto[];
  nextCursor: string | null;
}

function activeUser(userId: string): Prisma.UserWhereInput {
  return { id: userId, status: "ACTIVE", disabledAt: null, deletedAt: null };
}
function approvedMemberships(userId: string): Prisma.TeamMembershipWhereInput {
  return { userId, status: "APPROVED", user: activeUser(userId), team: { deletedAt: null } };
}
function pendingMemberships(userId: string): Prisma.TeamMembershipWhereInput {
  return { userId, status: "PENDING", user: activeUser(userId), team: { deletedAt: null } };
}
function incomingMemberships(userId: string): Prisma.TeamMembershipWhereInput {
  return {
    status: "PENDING",
    user: { status: "ACTIVE", disabledAt: null, deletedAt: null },
    team: {
      deletedAt: null,
      memberships: { some: { ...approvedMemberships(userId), role: { in: ["ADMIN", "MODERATOR"] } } },
    },
  };
}
const membershipOrder = [{ createdAt: "asc" as const }, { id: "asc" as const }];
const approvedSelect = {
  id: true,
  role: true,
  team: { select: { id: true, name: true, description: true, createdById: true } },
} as const;

function parseCursor(cursor?: string) {
  if (cursor === undefined) return undefined;
  const parsed = collectionCursorSchema.safeParse(cursor);
  return parsed.success ? parsed.data : null;
}

async function readApprovedTeamsPage(tx: Prisma.TransactionClient, userId: string, cursor?: string): Promise<ApprovedTeamsPageDto | null> {
  const where = approvedMemberships(userId);
  if (cursor && !await tx.teamMembership.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) return null;
  const rows = await tx.teamMembership.findMany({
    where, orderBy: membershipOrder,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: TEAM_TASK_PAGE_SIZE + 1,
    select: approvedSelect,
  });
  const page = rows.slice(0, TEAM_TASK_PAGE_SIZE);
  return {
    teams: page.map((row) => ({ teamId: row.team.id, name: row.team.name, description: row.team.description, teamRole: row.role, isOwner: row.team.createdById === userId })),
    nextCursor: rows.length > TEAM_TASK_PAGE_SIZE ? page.at(-1)?.id ?? null : null,
  };
}

/** Active-account, active-team, approved-membership-only navigation options. */
export async function getApprovedTeamsPage(userId: string, cursor?: string): Promise<ApprovedTeamsPageDto | null> {
  const parsedCursor = parseCursor(cursor);
  if (!userId || userId.length > 191 || parsedCursor === null) return null;
  return db.$transaction(async (tx) => {
    if (!await tx.user.findFirst({ where: activeUser(userId), select: { id: true } })) return null;
    return readApprovedTeamsPage(tx, userId, parsedCursor);
  }, { isolationLevel: "RepeatableRead" });
}

export async function getApprovedTeamNavigation(userId: string, activeTeamId?: string) {
  if (!userId || userId.length > 191 || (activeTeamId !== undefined && !teamIdSchema.safeParse(activeTeamId).success)) return null;
  return db.$transaction(async (tx) => {
    if (!await tx.user.findFirst({ where: activeUser(userId), select: { id: true } })) return null;
    const page = await readApprovedTeamsPage(tx, userId);
    if (!page) return null;
    const current = activeTeamId ? await tx.teamMembership.findFirst({ where: { ...approvedMemberships(userId), teamId: activeTeamId }, select: approvedSelect }) : null;
    return {
      page,
      activeTeam: current ? { teamId: current.team.id, name: current.team.name, description: current.team.description, teamRole: current.role, isOwner: current.team.createdById === userId } : null,
      scope: createHash("sha256").update(JSON.stringify([userId, activeTeamId, page.teams, page.nextCursor])).digest("hex"),
    };
  }, { isolationLevel: "RepeatableRead" });
}

/** Fetch only the selected task's collection; context uses bounded existence reads. */
export async function getTeamsWorkspaceData(userId: string, requestedView?: TeamsView, cursors: TeamsViewCursors = {}): Promise<TeamsWorkspaceDto | null> {
  if (!userId || userId.length > 191 || (requestedView !== undefined && !teamsViewSchema.safeParse(requestedView).success) || Object.values(cursors).some((cursor) => parseCursor(cursor) === null)) return null;
  return db.$transaction(async (tx) => {
    const actor = await tx.user.findFirst({ where: activeUser(userId), select: { role: true } });
    if (!actor) return null;
    const [approved, pending, managed, incoming] = await Promise.all([
      tx.teamMembership.findFirst({ where: approvedMemberships(userId), select: { id: true } }),
      tx.teamMembership.findFirst({ where: pendingMemberships(userId), select: { id: true } }),
      tx.teamMembership.findFirst({ where: { ...approvedMemberships(userId), role: { in: ["ADMIN", "MODERATOR"] } }, select: { id: true } }),
      tx.teamMembership.findFirst({ where: incomingMemberships(userId), select: { id: true } }),
    ]);
    const view = requestedView ?? (approved ? "teams" : pending ? "requests" : "discover");
    if (view === "approvals" && !managed) return null;
    const result: TeamsWorkspaceDto = {
      view, globalRole: actor.role,
      hasApprovedTeams: Boolean(approved), hasPendingRequests: Boolean(pending),
      canReviewRequests: Boolean(managed), hasIncomingRequests: Boolean(incoming),
      approvedTeams: [], discoverableTeams: [], pendingRequests: [], incomingRequests: [], nextCursor: null,
    };
    const cursor = cursors[view];
    if (view === "teams") {
      const page = await readApprovedTeamsPage(tx, userId, cursor);
      if (!page) return null;
      return { ...result, approvedTeams: page.teams, nextCursor: page.nextCursor };
    }
    if (view === "discover") {
      const where: Prisma.TeamWhereInput = { deletedAt: null, memberships: { none: { userId } } };
      if (cursor && !await tx.team.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) return null;
      const rows = await tx.team.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: TEAM_TASK_PAGE_SIZE + 1, select: { id: true, name: true, description: true } });
      const page = rows.slice(0, TEAM_TASK_PAGE_SIZE);
      return { ...result, discoverableTeams: page.map((row) => ({ teamId: row.id, name: row.name, description: row.description })), nextCursor: rows.length > TEAM_TASK_PAGE_SIZE ? page.at(-1)?.id ?? null : null };
    }
    const where = view === "requests" ? pendingMemberships(userId) : incomingMemberships(userId);
    if (cursor && !await tx.teamMembership.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) return null;
    const rows = await tx.teamMembership.findMany({
      where, orderBy: membershipOrder, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: TEAM_TASK_PAGE_SIZE + 1,
      select: { id: true, createdAt: true, team: { select: { id: true, name: true, description: true } }, user: { select: { name: true } } },
    });
    const page = rows.slice(0, TEAM_TASK_PAGE_SIZE);
    return {
      ...result,
      ...(view === "requests" ? { pendingRequests: page.map((row) => ({ teamId: row.team.id, name: row.team.name, description: row.team.description, requestedAt: row.createdAt.toISOString() })) } : { incomingRequests: page.map((row) => ({ membershipId: row.id, teamName: row.team.name, requesterName: row.user.name, requestedAt: row.createdAt.toISOString() })) }),
      nextCursor: rows.length > TEAM_TASK_PAGE_SIZE ? page.at(-1)?.id ?? null : null,
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function getRateLimitedTeamsWorkspaceData(userId: string, view?: TeamsView, cursors: TeamsViewCursors = {}) {
  await enforceUserRateLimit({ scope: "team-enumeration", userId, limit: 45, windowSeconds: 60 });
  return getTeamsWorkspaceData(userId, view, cursors);
}
