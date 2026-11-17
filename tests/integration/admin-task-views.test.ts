import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresTestDatabaseConfigured, openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

const describeWithDatabase = isPostgresTestDatabaseConfigured() ? describe : describe.skip;

describeWithDatabase("task-scoped administration reads", () => {
  let harness: PostgresTestHarness;
  let workflows: ReturnType<typeof import("@/lib/admin-workflows")["createPrismaAdminWorkflowRepository"]>;
  let administratorId: string;
  let moderatorId: string;
  let activeTeamId: string;
  let quarantinedTeamId: string;

  beforeAll(async () => {
    harness = await openPostgresTestHarness();
    await harness.clean();
    const now = new Date();
    const administrator = await harness.db.user.create({ data: { email: "task-admin@example.test", name: "Task Administrator", role: "ADMIN", status: "ACTIVE", lastAuthenticatedAt: now } });
    administratorId = administrator.id;
    moderatorId = (await harness.db.user.create({ data: { email: "task-moderator@example.test", role: "MODERATOR", status: "ACTIVE" } })).id;
    const pending = await harness.db.user.create({ data: { email: "task-invited@example.test", status: "PENDING" } });
    await harness.db.invitation.create({ data: { email: pending.email!, provisionedUserId: pending.id, invitedById: administratorId, expiresAt: new Date(now.getTime() + 7 * 86_400_000) } });
    activeTeamId = (await harness.db.team.create({ data: { name: "Task Active Team", createdById: administratorId } })).id;
    quarantinedTeamId = (await harness.db.team.create({ data: { name: "Task Recoverable Team", createdById: administratorId, deletedAt: new Date(now.getTime() - 86_400_000), purgeAfter: new Date(now.getTime() + 29 * 86_400_000) } })).id;
    await harness.db.team.create({ data: { name: "Task Expired Team", createdById: administratorId, deletedAt: new Date(now.getTime() - 31 * 86_400_000), purgeAfter: new Date(now.getTime() - 86_400_000) } });
    await harness.db.teamMembership.createMany({ data: [activeTeamId, quarantinedTeamId].map((teamId) => ({ teamId, userId: administratorId, status: "APPROVED", role: "ADMIN" })) });
    workflows = (await import("@/lib/admin-workflows")).createPrismaAdminWorkflowRepository(harness.db);
  });
  afterAll(async () => harness?.close());

  it("returns only the selected task and separates active access from recovery", async () => {
    const accounts = await workflows.getConsoleData(administratorId, undefined, {}, "accounts");
    expect(accounts?.users.length).toBeGreaterThan(0);
    expect(accounts?.invitations).toEqual([]);
    expect(accounts?.teams).toEqual([]);
    const invitations = await workflows.getConsoleData(administratorId, undefined, {}, "invitations");
    expect(invitations?.users).toEqual([]);
    expect(invitations?.invitations).toHaveLength(1);
    expect(invitations?.teams).toEqual([]);
    const access = await workflows.getConsoleData(administratorId, undefined, {}, "access");
    expect(access?.teams.map((team) => team.teamId)).toEqual([activeTeamId]);
    expect(access?.teams[0]?.members).toHaveLength(1);
    const recovery = await workflows.getConsoleData(administratorId, undefined, {}, "recovery");
    expect(recovery?.users).toEqual([]);
    expect(recovery?.invitations).toEqual([]);
    expect(recovery?.teams).toHaveLength(2);
    expect(recovery?.teams.every((team) => team.members.length === 0 && team.nextMemberCursor === null)).toBe(true);
    expect(recovery?.teams.find((team) => team.teamId === quarantinedTeamId)?.recoveryEligibility).toBe("eligible");
    expect(recovery?.teams.find((team) => team.name === "Task Expired Team")?.recoveryEligibility).toBe("expired");
  });

  it("authorizes each view, search and cursor against its current scope", async () => {
    for (const view of ["accounts", "invitations", "access", "recovery"] as const) {
      expect(await workflows.getConsoleData(moderatorId, undefined, {}, view)).toBeNull();
    }
    expect(await workflows.getConsoleData(administratorId, undefined, { teams: quarantinedTeamId }, "access")).toBeNull();
    expect(await workflows.getConsoleData(administratorId, undefined, { teams: activeTeamId }, "recovery")).toBeNull();
    const search = await workflows.getConsoleData(administratorId, "Recoverable", {}, "recovery");
    expect(search?.teams.map((team) => team.teamId)).toEqual([quarantinedTeamId]);
  });
});
