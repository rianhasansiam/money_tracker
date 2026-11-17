import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { hashSessionToken } from "@/lib/auth-adapter";
import { SESSION_HEADER, startBrowserSessionProxy } from "../helpers/browser-session-proxy";
import { openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

let harness: PostgresTestHarness;
let proxy: Awaited<ReturnType<typeof startBrowserSessionProxy>>;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let moderatorId: string;
let teams: Array<{ id: string; name: string }>;
let tokens: Record<string, string>;
const name = (index: number) => `Access team ${String(index + 1).padStart(3, "0")}`;
function url(path: string) { return new URL(path, proxy.origin).toString(); }
async function session(context: BrowserContext, actor: string) { await context.setExtraHTTPHeaders({ [SESSION_HEADER]: tokens[actor] }); }

test.beforeAll(async () => {
  if (!process.env.E2E_BASE_URL) throw new Error("E2E_BASE_URL is required.");
  proxy = await startBrowserSessionProxy(process.env.E2E_BASE_URL);
  harness = await openPostgresTestHarness();
});
test.beforeEach(async () => {
  await harness.clean();
  const now = new Date();
  const actors = await Promise.all([
    { key: "owner", role: "ADMIN" as const, name: "Team owner" },
    { key: "member", role: "MEMBER" as const, name: "Newly admitted member" },
    { key: "outsider", role: "ADMIN" as const, name: "Global Admin without membership" },
    { key: "moderator", role: "MODERATOR" as const, name: "Global Moderator with read-only membership" },
  ].map(async (actor) => ({ ...actor, user: await harness.db.user.create({ data: { name: actor.name, email: `${actor.key}@teams-usability.example.test`, role: actor.role, status: "ACTIVE", emailVerified: now, lastAuthenticatedAt: now } }) })));
  ownerId = actors[0].user.id; memberId = actors[1].user.id; outsiderId = actors[2].user.id; moderatorId = actors[3].user.id;
  teams = [];
  for (let index = 0; index < 26; index += 1) {
    const team = await harness.db.team.create({ data: { name: name(index), description: `Shared BDT ledger for ${name(index)}`, createdById: ownerId } });
    teams.push({ id: team.id, name: team.name });
    await harness.db.teamMembership.create({ data: { teamId: team.id, userId: ownerId, role: "ADMIN", status: "APPROVED", approvedAt: now, approvedById: ownerId } });
  }
  await harness.db.teamMembership.create({ data: { teamId: teams[0].id, userId: moderatorId, role: "MEMBER", status: "APPROVED", approvedAt: now, approvedById: ownerId } });
  tokens = {};
  for (const actor of actors) {
    tokens[actor.key] = `teams-usability-${actor.key}-${randomUUID()}`;
    await harness.db.session.create({ data: { userId: actor.user.id, sessionToken: hashSessionToken(tokens[actor.key]), expires: new Date(now.getTime() + 60 * 60_000) } });
  }
});
test.afterAll(async () => { await proxy?.close(); await harness?.close(); });

test("guides an active account through discovery, request and separate team approval", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const ownerContext = await browser.newContext();
  await session(memberContext, "member"); await session(ownerContext, "owner");
  const member = await memberContext.newPage(); const owner = await ownerContext.newPage();
  try {
    await member.goto(url("/groups"));
    await expect(member.getByRole("heading", { name: "Discover teams", exact: true })).toBeVisible();
    await expect(member.getByText("Your account is active. Request access to a team to view its ledger.", { exact: true })).toBeVisible();
    const originalViewport = member.viewportSize();
    await member.setViewportSize({ width: 390, height: 900 });
    await member.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
    const artifacts = resolve("docs/usability/screenshots/after");
    await mkdir(artifacts, { recursive: true });
    await member.screenshot({ path: resolve(artifacts, "teams-first-admission-390.png"), animations: "disabled" });
    if (originalViewport) await member.setViewportSize(originalViewport);
    const target = member.getByRole("list", { name: "Teams available to request" }).getByRole("listitem").filter({ has: member.getByRole("heading", { name: teams[0].name, exact: true }) });
    await target.getByRole("button", { name: "Request to join", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(member).toHaveURL(/view=requests/);
    await expect(member.getByRole("heading", { name: "Your requests", exact: true })).toBeVisible();
    await expect(member.getByText("Awaiting team approval", { exact: true })).toBeVisible();
    await expect(member.getByRole("button", { name: "Open team", exact: true })).toHaveCount(0);
    expect(await harness.db.teamMembership.count({ where: { teamId: teams[0].id, userId: memberId } })).toBe(1);
    await owner.goto(url("/groups"));
    await owner.getByRole("navigation", { name: "Teams views" }).getByRole("link", { name: /^Approvals/ }).click();
    await expect(owner.getByRole("list", { name: "Incoming team requests" })).toContainText("Newly admitted member");
    await owner.getByRole("button", { name: "Approve request", exact: true }).click();
    await expect(owner.getByRole("heading", { name: "No requests waiting", exact: true })).toBeVisible();
    await member.getByRole("navigation", { name: "Teams views" }).getByRole("link", { name: "Your teams", exact: true }).click();
    await member.getByRole("link", { name: "Open team", exact: true }).click();
    await expect(member.getByRole("heading", { name: teams[0].name, exact: true })).toBeVisible();
    await expect(member.getByText(/Team role: Member/).filter({ visible: true }).first()).toBeVisible();
    await expect(member.getByRole("button", { name: "Add money", exact: true })).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Remove money", exact: true })).toHaveCount(0);
  } finally { await memberContext.close(); await ownerContext.close(); }
});

test("keeps approved, discover and request pages independent through task navigation", async ({ page, context }) => {
  await session(context, "owner");
  await page.goto(url("/groups"));
  await expect(page.getByRole("heading", { name: "Your teams", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your approved teams" }).getByRole("listitem")).toHaveCount(20);
  await page.getByRole("navigation", { name: "Your teams pagination" }).getByRole("link", { name: "Next page", exact: true }).click();
  await expect(page).toHaveURL(/teamCursor=/);
  const cursor = new URL(page.url()).searchParams.get("teamCursor");
  expect(cursor).toBeTruthy();
  await expect(page.getByRole("list", { name: "Your approved teams" }).getByRole("listitem")).toHaveCount(6);
  const tasks = page.getByRole("navigation", { name: "Teams views" });
  await tasks.getByRole("link", { name: "Discover teams", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Discover teams", exact: true })).toBeVisible();
  await tasks.getByRole("link", { name: "Your requests", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your requests", exact: true })).toBeVisible();
  await tasks.getByRole("link", { name: "Your teams", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your teams", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("teamCursor")).toBe(cursor);
  await expect(page.getByRole("list", { name: "Your approved teams" }).getByRole("listitem")).toHaveCount(6);
  await page.getByRole("navigation", { name: "Your teams pagination" }).getByRole("link", { name: "First page", exact: true }).click();
  await expect(page.getByRole("list", { name: "Your approved teams" }).getByRole("listitem")).toHaveCount(20);
});

test("bounds the switcher and excludes pending, revoked and quarantined teams", async ({ page, context }) => {
  const now = new Date();
  for (const status of ["PENDING", "REVOKED"] as const) {
    const team = await harness.db.team.create({ data: { name: `Excluded ${status} team`, createdById: outsiderId } });
    await harness.db.teamMembership.createMany({ data: [{ teamId: team.id, userId: outsiderId, role: "ADMIN", status: "APPROVED", approvedAt: now, approvedById: outsiderId }, { teamId: team.id, userId: ownerId, role: "MEMBER", status, approvedAt: null, approvedById: null }] });
  }
  const quarantined = await harness.db.team.create({ data: { name: "Excluded quarantined team", createdById: ownerId, deletedAt: now, purgeAfter: new Date(now.getTime() + 30 * 24 * 60 * 60_000), deletedById: ownerId } });
  await harness.db.teamMembership.create({ data: { teamId: quarantined.id, userId: ownerId, role: "ADMIN", status: "APPROVED", approvedAt: now, approvedById: ownerId } });
  await session(context, "owner");
  await page.goto(url("/groups"));
  await page.getByRole("button", { name: "Choose a team", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch team", exact: true });
  const options = dialog.getByRole("list", { name: "Approved active teams" });
  await expect(options.getByRole("listitem")).toHaveCount(20);
  await dialog.getByRole("button", { name: "Load more teams", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(options.getByRole("listitem")).toHaveCount(26);
  await expect(dialog.getByText("26 teams loaded", { exact: true })).toBeFocused();
  await expect(dialog.getByText(/Excluded/)).toHaveCount(0);
  await options.getByRole("link").filter({ hasText: teams[25].name }).click();
  await expect(page.getByRole("heading", { name: teams[25].name, exact: true })).toBeVisible();
});

test("keeps Global Admin and Global Moderator separate from approved team authority", async ({ browser }) => {
  for (const actor of ["outsider", "moderator"]) {
    const context = await browser.newContext(); await session(context, actor);
    const page = await context.newPage();
    try {
      await page.goto(url("/groups?view=approvals"));
      await expect(page.getByRole("navigation", { name: "Teams views" }).getByRole("link", { name: /^Approvals/ })).toHaveCount(0);
      if (actor === "outsider") {
        await page.goto(url(`/dashboard/${teams[0].id}`));
        await expect(page).toHaveURL(/\/groups/);
        await page.getByRole("button", { name: "Choose a team", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Switch team" }).locator('a[href^="/dashboard/"]')).toHaveCount(0);
      } else {
        await page.goto(url(`/dashboard/${teams[0].id}`));
        await expect(page.getByText("View-only access.", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Add money", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Remove money", exact: true })).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Administration", exact: true })).toHaveCount(0);
      }
    } finally { await context.close(); }
  }
});
