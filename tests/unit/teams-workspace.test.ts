import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const actor = vi.fn();
  const membershipFirst = vi.fn();
  const membershipMany = vi.fn();
  const teamFirst = vi.fn();
  const teamMany = vi.fn();
  const tx = { user: { findFirst: actor }, teamMembership: { findFirst: membershipFirst, findMany: membershipMany }, team: { findFirst: teamFirst, findMany: teamMany } };
  return { actor, membershipFirst, membershipMany, teamFirst, teamMany, transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)), limit: vi.fn() };
});
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.limit }));
import { getApprovedTeamsPage, getApprovedTeamNavigation, getTeamsWorkspaceData, getRateLimitedTeamsWorkspaceData, TEAM_TASK_PAGE_SIZE } from "@/lib/queries/teams";

const cursor = "clh1234567890abcdefghijk";
const teamId = "clh1234567890abcdefghijl";
function row(index: number, owner = "viewer") {
  return { id: `membership-${index}`, role: "MEMBER", team: { id: `team-${index}`, name: `Team ${index}`, description: null, createdById: owner } };
}
function context(approved: boolean, pending: boolean, managed: boolean, incoming: boolean) {
  mocks.membershipFirst.mockResolvedValueOnce(approved ? { id: "approved" } : null).mockResolvedValueOnce(pending ? { id: "pending" } : null).mockResolvedValueOnce(managed ? { id: "managed" } : null).mockResolvedValueOnce(incoming ? { id: "incoming" } : null);
}

describe("authorized bounded Teams task and switcher queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.mockReset().mockResolvedValue({ id: "viewer", role: "MEMBER" });
    mocks.membershipFirst.mockReset();
    mocks.membershipMany.mockReset().mockResolvedValue([]);
    mocks.teamFirst.mockReset();
    mocks.teamMany.mockReset().mockResolvedValue([]);
    mocks.limit.mockResolvedValue(undefined);
  });

  it("does not expose team collections to an inactive or missing account", async () => {
    mocks.actor.mockResolvedValue(null);
    expect(await getApprovedTeamsPage("viewer")).toBeNull();
    expect(await getTeamsWorkspaceData("viewer", "discover")).toBeNull();
    expect(mocks.membershipFirst).not.toHaveBeenCalled();
    expect(mocks.teamMany).not.toHaveBeenCalled();
    expect(mocks.actor).toHaveBeenCalledWith({ where: { id: "viewer", status: "ACTIVE", disabledAt: null, deletedAt: null }, select: expect.anything() });
  });

  it("bounds approved active-team options and returns no internal account or owner identifiers", async () => {
    mocks.membershipMany.mockResolvedValue(Array.from({ length: TEAM_TASK_PAGE_SIZE + 1 }, (_, index) => row(index)));
    const page = await getApprovedTeamsPage("viewer");
    expect(page?.teams).toHaveLength(20);
    expect(page?.nextCursor).toBe("membership-19");
    expect(page?.teams[0]).toMatchObject({ teamRole: "MEMBER", isOwner: true });
    expect(JSON.stringify(page)).not.toContain("createdById");
    expect(JSON.stringify(page)).not.toContain("viewer");
    expect(mocks.membershipMany).toHaveBeenCalledWith(expect.objectContaining({ take: 21, where: { userId: "viewer", status: "APPROVED", user: { id: "viewer", status: "ACTIVE", disabledAt: null, deletedAt: null }, team: { deletedAt: null } } }));
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
  });

  it("re-authorizes a switcher cursor before returning the next page", async () => {
    mocks.membershipFirst.mockResolvedValue(null);
    expect(await getApprovedTeamsPage("viewer", cursor)).toBeNull();
    expect(mocks.membershipMany).not.toHaveBeenCalled();
    expect(mocks.membershipFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: cursor, userId: "viewer", status: "APPROVED" }) }));
  });

  it("authorizes the current team separately when it lies beyond the first options page", async () => {
    mocks.membershipFirst.mockResolvedValue({ ...row(42, "other"), team: { ...row(42).team, id: teamId, createdById: "other" } });
    const navigation = await getApprovedTeamNavigation("viewer", teamId);
    expect(navigation?.activeTeam).toMatchObject({ teamId, teamRole: "MEMBER", isOwner: false });
    expect(navigation?.scope).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.membershipFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ teamId, userId: "viewer", status: "APPROVED", team: { deletedAt: null } }) }));
  });

  it("defaults an approved viewer to Your teams and reads only that collection", async () => {
    context(true, true, true, true);
    mocks.membershipMany.mockResolvedValue([row(0)]);
    const data = await getTeamsWorkspaceData("viewer");
    expect(data).toMatchObject({ view: "teams", hasIncomingRequests: true, approvedTeams: [{ teamRole: "MEMBER" }], pendingRequests: [], incomingRequests: [], discoverableTeams: [] });
    expect(mocks.membershipMany).toHaveBeenCalledTimes(1);
    expect(mocks.teamMany).not.toHaveBeenCalled();
  });

  it("defaults a waiting viewer to Your requests and a newly admitted viewer to Discover", async () => {
    context(false, true, false, false);
    expect(await getTeamsWorkspaceData("viewer")).toMatchObject({ view: "requests", hasPendingRequests: true });
    context(false, false, false, false);
    expect(await getTeamsWorkspaceData("viewer")).toMatchObject({ view: "discover", hasApprovedTeams: false });
  });

  it.each(["ADMIN", "MODERATOR"])("does not infer approval authority from Global %s", async (role) => {
    mocks.actor.mockResolvedValue({ role });
    context(false, false, false, false);
    expect(await getTeamsWorkspaceData("viewer", "approvals")).toBeNull();
    expect(mocks.membershipMany).not.toHaveBeenCalled();
  });

  it("excludes every existing membership, including revoked access, from discovery", async () => {
    context(true, false, false, false);
    await getTeamsWorkspaceData("viewer", "discover");
    expect(mocks.teamMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, memberships: { none: { userId: "viewer" } } }, take: 21 }));
    expect(mocks.membershipMany).not.toHaveBeenCalled();
  });

  it("keeps outgoing and incoming membership cursors scoped to their distinct task", async () => {
    context(true, true, true, true);
    mocks.membershipFirst.mockResolvedValueOnce(null);
    expect(await getTeamsWorkspaceData("viewer", "requests", { requests: cursor })).toBeNull();
    expect(mocks.membershipMany).not.toHaveBeenCalled();
    expect(mocks.membershipFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: cursor, status: "PENDING", userId: "viewer" }) }));
  });

  it("fails malformed task state before any database read and preserves enumeration limits", async () => {
    expect(await getTeamsWorkspaceData("viewer", "unrecognized" as "teams")).toBeNull();
    expect(await getApprovedTeamsPage("viewer", "bad-cursor")).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
    context(false, false, false, false);
    await getRateLimitedTeamsWorkspaceData("viewer", "discover");
    expect(mocks.limit).toHaveBeenCalledWith({ scope: "team-enumeration", userId: "viewer", limit: 45, windowSeconds: 60 });
  });
});
