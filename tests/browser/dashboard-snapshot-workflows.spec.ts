import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { hashSessionToken } from "@/lib/auth-adapter";
import { getBusinessTodayDateInputValue, parseTransactionDateInput } from "@/lib/date-time";
import { SESSION_HEADER, startBrowserSessionProxy } from "../helpers/browser-session-proxy";
import { openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

let harness: PostgresTestHarness;
let proxy: Awaited<ReturnType<typeof startBrowserSessionProxy>>;
let actorId: string;
let token: string;
let teamId: string;
let secondTeamId: string;
const primaryName = "Snapshot primary treasury";
const secondaryName = "Snapshot second treasury";

function browserUrl(path: string) { return new URL(path, proxy.origin).toString(); }
function visibleEntries(page: Page) { return page.locator("[data-ledger-entry]:visible"); }

async function seedEntries(count: number, targetTeam = teamId) {
  const now = new Date();
  await harness.db.transaction.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      teamId: targetTeam,
      userId: actorId,
      actorIdSnapshot: actorId,
      actorNameSnapshot: "Snapshot administrator",
      idempotencyKey: randomUUID(),
      amountInCents: 100,
      type: "ADD" as const,
      note: `Seed entry ${index + 1}`,
      transactionDate: parseTransactionDateInput(getBusinessTodayDateInputValue()),
      createdAt: new Date(now.getTime() - index * 1_000),
    })),
  });
}

async function addition(page: Page, amount: string, note: string) {
  if (!await page.getByRole("dialog", { name: /^(Add money|Remove money)$/ }).isVisible()) await page.getByRole("button", { name: "Add money", exact: true }).click();
  await page.getByLabel("Amount in BDT", { exact: true }).fill(amount);
  await page.locator("#note").fill(note);
  await page.getByRole("button", { name: "Save addition", exact: true }).click();
}

/** Hold a real Server Action response after the server has completed its work. */
async function holdActionResponse(page: Page, matches: (body: string) => boolean) {
  let entered!: () => void;
  let release!: () => void;
  let finished!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fulfilled = new Promise<void>((resolve) => { finished = resolve; });
  let claimed = false;
  const handler = async (route: Route) => {
    const request = route.request();
    if (claimed || request.method() !== "POST" || !request.headers()["next-action"] || !matches(request.postData() ?? "")) {
      await route.continue();
      return;
    }
    claimed = true;
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
    finished();
  };
  await page.route("**/dashboard/**", handler);
  return {
    ready,
    async release() {
      release();
      await fulfilled;
      await page.unroute("**/dashboard/**", handler);
    },
  };
}

test.beforeAll(async () => {
  if (!process.env.E2E_BASE_URL) throw new Error("E2E_BASE_URL is required for browser tests.");
  proxy = await startBrowserSessionProxy(process.env.E2E_BASE_URL);
  harness = await openPostgresTestHarness();
});

test.beforeEach(async ({ context }) => {
  await harness.clean();
  const now = new Date();
  const actor = await harness.db.user.create({
    data: { name: "Snapshot administrator", email: "snapshot-admin@example.test", emailVerified: now, role: "ADMIN", status: "ACTIVE", lastAuthenticatedAt: now },
  });
  actorId = actor.id;
  const primary = await harness.db.team.create({ data: { name: primaryName, createdById: actorId } });
  const secondary = await harness.db.team.create({ data: { name: secondaryName, createdById: actorId } });
  teamId = primary.id;
  secondTeamId = secondary.id;
  await harness.db.teamMembership.createMany({
    data: [teamId, secondTeamId].map((id) => ({ teamId: id, userId: actorId, role: "ADMIN" as const, status: "APPROVED" as const, approvedAt: now, approvedById: actorId })),
  });
  token = `snapshot-session-${randomUUID()}`;
  await harness.db.session.create({ data: { userId: actorId, sessionToken: hashSessionToken(token), expires: new Date(now.getTime() + 60 * 60 * 1_000) } });
  await context.setExtraHTTPHeaders({ [SESSION_HEADER]: token });
});

test.afterAll(async () => {
  await proxy?.close();
  await harness?.close();
});

test("shows the first confirmed save without reloading and prevents rapid duplicate submission", async ({ page }) => {
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await expect(page.getByText("No transactions yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await page.getByLabel("Amount in BDT", { exact: true }).fill("1.25");
  await page.locator("#note").fill("First visible funding");
  await page.getByRole("button", { name: "Save addition", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(visibleEntries(page).filter({ hasText: "First visible funding" })).toHaveCount(1);
  await expect(page.getByText("No transactions yet", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1 loaded", { exact: true })).toBeVisible();
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 1.25");
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("");
  expect(await harness.db.transaction.count({ where: { teamId } })).toBe(1);
});

test("resets loaded pages after a save and explains a backdated entry outside the first page", async ({ page }) => {
  await seedEntries(28);
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await expect(page.getByText("28 loaded", { exact: true })).toBeVisible();
  await addition(page, "5.00", "Funding after pagination");
  await expect(visibleEntries(page).filter({ hasText: "Funding after pagination" })).toHaveCount(1);
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "History has reset to the newest matching first page" })).toBeVisible();
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 33.00");
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await page.getByLabel("Transaction date", { exact: true }).fill("2000-01-01");
  await addition(page, "2.00", "Backdated contribution");
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: "outside the current filters or first page" })).toBeVisible();
  await expect(visibleEntries(page).filter({ hasText: "Backdated contribution" })).toHaveCount(0);
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 35.00");
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await expect(page.getByText("30 loaded", { exact: true })).toBeVisible();
  await expect(visibleEntries(page).last()).toContainText("Backdated contribution");
});

test("keeps entered values after rejection and waits for a real success response", async ({ page }) => {
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await page.getByRole("button", { name: "Remove money", exact: true }).click();
  await page.locator("#type").selectOption("REMOVE");
  await page.getByLabel("Amount in BDT", { exact: true }).fill("10.00");
  await page.locator("#note").fill("Rejected withdrawal");
  await page.getByRole("button", { name: "Save removal", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Insufficient balance" })).toBeVisible();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("10.00");
  await expect(page.locator("#note")).toHaveValue("Rejected withdrawal");
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 0.00");
  await page.locator("#type").selectOption("ADD");
  const held = await holdActionResponse(page, (body) => body.includes("Pending confirmed addition"));
  await addition(page, "3.00", "Pending confirmed addition");
  await held.ready;
  await expect(page.getByRole("button", { name: "Saving transaction...", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toBeDisabled();
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 0.00");
  await expect(visibleEntries(page)).toHaveCount(0);
  await held.release();
  await expect(visibleEntries(page).filter({ hasText: "Pending confirmed addition" })).toHaveCount(1);
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 3.00");
});

test("safely retries an uncertain committed save with the same operation key", async ({ page }) => {
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  let lostResponse = false;
  await page.route("**/dashboard/**", async (route) => {
    if (!lostResponse && route.request().method() === "POST" && route.request().headers()["next-action"] && (route.request().postData() ?? "").includes("Uncertain committed entry")) {
      lostResponse = true;
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await addition(page, "4.00", "Uncertain committed entry");
  await expect(page.getByRole("alert").filter({ hasText: "could not confirm the response" })).toBeVisible();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("4.00");
  await expect(page.locator("#transaction-form")).toHaveAttribute("data-entry-phase", "outcome-unknown");
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.getByRole("button", { name: "Remove money", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add money", exact: true })).toBeVisible();
  await expect(page.locator("#type")).toHaveValue("ADD");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.getByRole("button", { name: primaryName, exact: true }).click();
  await page.getByRole("dialog", { name: "Switch team", exact: true }).locator(`a[href="/dashboard/${secondTeamId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${secondTeamId}$`));
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${teamId}$`));
  await page.getByRole("button", { name: "Resume unchanged operation", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("4.00");
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toBeDisabled();
  expect(await harness.db.transaction.count({ where: { teamId: secondTeamId } })).toBe(0);
  await harness.db.rateLimitBucket.updateMany({ where: { scope: "transaction-create" }, data: { count: 60 } });
  await page.getByRole("button", { name: "Retry unchanged addition", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many transaction requests" })).toBeVisible();
  await expect(page.locator("#transaction-form")).toHaveAttribute("data-entry-phase", "outcome-unknown");
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toBeDisabled();
  await harness.db.rateLimitBucket.deleteMany({ where: { scope: "transaction-create" } });
  await page.getByRole("button", { name: "Retry unchanged addition", exact: true }).click();
  await expect(visibleEntries(page).filter({ hasText: "Uncertain committed entry" })).toHaveCount(1);
  expect(await harness.db.transaction.count({ where: { teamId, note: "Uncertain committed entry" } })).toBe(1);
});

test("discards delayed history after receiving a fresh dashboard snapshot", async ({ page }) => {
  await seedEntries(28);
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  const firstHeld = await holdActionResponse(page, (body) => body.includes(teamId));
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await firstHeld.ready;
  await harness.db.transaction.create({ data: { teamId, userId: actorId, actorIdSnapshot: actorId, actorNameSnapshot: "Snapshot administrator", idempotencyKey: randomUUID(), amountInCents: 200, type: "ADD", note: "Concurrent fresh funding", transactionDate: parseTransactionDateInput(getBusinessTodayDateInputValue()) } });
  await page.locator('a[href="/groups"]').first().click();
  await page.locator(`a[href="/dashboard/${teamId}"]:visible`).first().click();
  let captureFreshBody!: (body: string) => void;
  const freshBody = new Promise<string>((resolve) => { captureFreshBody = resolve; });
  const captureRefresh = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() !== "POST" || url.pathname !== `/dashboard/${teamId}` ||
      !request.headers()["next-action"]
    ) {
      await route.fallback();
      return;
    }
    // Retain the actual HTTP body in Playwright's APIResponse. Reading a
    // browser Response later relies on Chromium's evictable CDP body cache.
    // This is the genuine coherent snapshot Server Action response.
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response });
    if (body.includes("Concurrent fresh funding")) captureFreshBody(body);
  };
  await page.route("**/dashboard/**", captureRefresh);
  await page.getByRole("button", { name: "Refresh dashboard", exact: true }).click();
  expect(await freshBody).toContain("Concurrent fresh funding");
  await page.unroute("**/dashboard/**", captureRefresh);
  // React may entangle the pending action and navigation transitions. Deliver
  // the older page after the fresh RSC response, then assert the settled UI.
  await firstHeld.release();
  await expect(visibleEntries(page).filter({ hasText: "Concurrent fresh funding" })).toHaveCount(1);
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 30.00");
});

test("discards a delayed page after browser history switches the active team", async ({ page }) => {
  await seedEntries(28);
  await harness.db.transaction.create({ data: { teamId: secondTeamId, userId: actorId, actorIdSnapshot: actorId, actorNameSnapshot: "Snapshot administrator", idempotencyKey: randomUUID(), amountInCents: 5_000, type: "ADD", note: "Second team only", transactionDate: parseTransactionDateInput(getBusinessTodayDateInputValue()) } });
  await page.goto(browserUrl(`/dashboard/${secondTeamId}`));
  await page.locator('a[href="/groups"]').first().click();
  await page.locator(`a[href="/dashboard/${teamId}"]:visible`).first().click();
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  const held = await holdActionResponse(page, (body) => body.includes(teamId));
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await held.ready;
  // Browser history can issue the second navigation even while React retains
  // the previous screen for an entangled, pending action transition.
  await page.goBack();
  await page.goBack();
  await held.release();
  await expect(visibleEntries(page).filter({ hasText: "Second team only" })).toHaveCount(1);
  await expect(visibleEntries(page)).toHaveCount(1);
  await expect(visibleEntries(page).filter({ hasText: "Seed entry" })).toHaveCount(0);
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 50.00");
});

test("keeps real financial values readable across supported viewport widths", async ({ page }) => {
  await seedEntries(2);
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("team-balance")).toBeVisible();
    await expect(visibleEntries(page)).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await expect(page.getByRole("table")).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId("team-balance")).toBeVisible();
});

test("refreshes the whole snapshot when another writer changes the ledger between pages", async ({ page }) => {
  await seedEntries(28);
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 28.00");
  await harness.db.transaction.create({
    data: {
      teamId, userId: actorId, actorIdSnapshot: actorId,
      actorNameSnapshot: "Snapshot administrator", idempotencyKey: randomUUID(),
      amountInCents: 200, type: "ADD", note: "External backdated entry",
      transactionDate: parseTransactionDateInput("2000-01-01"),
    },
  });
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await expect(page.getByTestId("team-balance")).toHaveText("BDT 30.00");
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "The history view was updated" })).toBeVisible();
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await expect(page.getByText("29 loaded", { exact: true })).toBeVisible();
  await expect(visibleEntries(page).last()).toContainText("External backdated entry");
});

test("keeps keyboard focus and scroll stable while loading and completing history", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedEntries(55);
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  const button = page.getByRole("button", { name: "Load more transactions", exact: true });
  let historyRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) historyRequests += 1;
  });
  const firstHeld = await holdActionResponse(page, (body) => body.includes(teamId));
  await button.scrollIntoViewIfNeeded();
  await button.focus();
  const before = await page.evaluate(() => ({ scrollY: window.scrollY, active: document.activeElement?.textContent?.trim() }));
  await button.press("Enter");
  await firstHeld.ready;
  await page.getByRole("button", { name: "Loading history...", exact: true }).press("Enter");
  const pending = await page.evaluate(() => ({ scrollY: window.scrollY, activeTag: document.activeElement?.tagName, active: document.activeElement?.textContent?.trim().slice(0, 60) }));
  await firstHeld.release();
  await expect(page.getByText("50 loaded", { exact: true })).toBeVisible();
  const afterPage = await page.evaluate(() => ({ scrollY: window.scrollY, activeTag: document.activeElement?.tagName, active: document.activeElement?.textContent?.trim().slice(0, 60) }));
  await button.focus();
  const finalBefore = await page.evaluate(() => window.scrollY);
  const finalHeld = await holdActionResponse(page, (body) => body.includes(teamId));
  await button.press("Enter");
  await finalHeld.ready;
  const finalPending = await page.evaluate(() => ({ scrollY: window.scrollY, activeTag: document.activeElement?.tagName, active: document.activeElement?.textContent?.trim().slice(0, 60) }));
  await finalHeld.release();
  await expect(page.getByText("55 loaded", { exact: true })).toBeVisible();
  const completed = await page.evaluate(() => ({ scrollY: window.scrollY, activeTag: document.activeElement?.tagName, active: document.activeElement?.textContent?.trim().slice(0, 60) }));
  await testInfo.attach("pagination-focus", { body: JSON.stringify({ before, pending, afterPage, finalBefore, finalPending, completed }, null, 2), contentType: "application/json" });
  expect(pending.activeTag).toBe("BUTTON");
  expect(pending.active).toContain("Loading history");
  expect(afterPage.active).toBe("Load more transactions");
  expect(Math.abs(pending.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPage.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
  expect(finalPending.activeTag).toBe("BUTTON");
  expect(completed.active).toBe("All available transactions are loaded.");
  expect(Math.abs(completed.scrollY - finalBefore)).toBeLessThanOrEqual(1);
  expect(historyRequests).toBe(2);
});


test("retains separate in-memory drafts through team switching and browser back and forward", async ({ page }) => {
  await page.goto(browserUrl("/"));
  await page.locator('a[href="/groups"]:visible').first().click();
  await page.locator(`a[href="/dashboard/${teamId}"]:visible`).first().click();
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await expect(page.getByLabel("Transaction date", { exact: true })).toHaveValue(getBusinessTodayDateInputValue());
  await page.getByLabel("Amount in BDT", { exact: true }).fill("9.99");
  await page.locator("#note").fill("Primary team draft");
  await page.getByLabel("Transaction date", { exact: true }).fill("0099-02-03");
  await expect(page.getByText("18/240 characters", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.getByRole("button", { name: primaryName, exact: true }).click();
  await page.getByRole("dialog", { name: "Switch team", exact: true }).locator(`a[href="/dashboard/${secondTeamId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${secondTeamId}$`));
  await page.getByRole("button", { name: "Remove money", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("");
  await expect(page.locator("#type")).toHaveValue("REMOVE");
  await page.getByLabel("Amount in BDT", { exact: true }).fill("2.00");
  await page.locator("#note").fill("Second team draft");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${teamId}$`));
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("9.99");
  await expect(page.locator("#note")).toHaveValue("Primary team draft");
  await expect(page.locator("#type")).toHaveValue("ADD");
  await expect(page.getByLabel("Transaction date", { exact: true })).toHaveValue("0099-02-03");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${secondTeamId}$`));
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("2.00");
  await expect(page.locator("#note")).toHaveValue("Second team draft");
  await expect(page.locator("#type")).toHaveValue("REMOVE");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${teamId}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/groups/);
  await page.goBack();
  await expect(page).toHaveURL(browserUrl("/"));
  await page.goForward();
  await expect(page).toHaveURL(/\/groups/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${teamId}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${secondTeamId}$`));
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("2.00");
  await expect(page.locator("#note")).toHaveValue("Second team draft");
  expect(await harness.db.transaction.count()).toBe(0);
  expect(new URL(page.url()).search).toBe("");
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state }));
  expect(storage).not.toContain("Primary team draft");
  expect(storage).not.toContain("Second team draft");
});

test("requires an explicit session-leave decision before clearing a retained financial draft", async ({ page, context }) => {
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await page.getByLabel("Amount in BDT", { exact: true }).fill("7.50");
  await page.locator("#note").fill("Retained before sign-out");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out and discard these drafts?", exact: true });
  await expect(dialog).toBeVisible();
  expect(await harness.db.session.count({ where: { userId: actorId } })).toBe(1);
  expect(await harness.db.transaction.count()).toBe(0);
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("7.50");
  await page.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard drafts and leave session", exact: true }).click();
  await expect(page).toHaveURL(browserUrl("/"));
  expect(await harness.db.session.count({ where: { userId: actorId } })).toBe(0);
  expect(await harness.db.transaction.count()).toBe(0);
  const replacement = `fresh-memory-${randomUUID()}`;
  await harness.db.session.create({ data: { userId: actorId, sessionToken: hashSessionToken(replacement), expires: new Date(Date.now() + 60 * 60 * 1000) } });
  await context.setExtraHTTPHeaders({ [SESSION_HEADER]: replacement });
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/groups/);
  await page.locator(`a[href="/dashboard/${teamId}"]:visible`).first().click();
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("");
  await expect(page.locator("#note")).toHaveValue("");
});

test("keeps entry controls reachable when the mobile visible viewport shrinks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(browserUrl(`/dashboard/${teamId}`));
  await page.getByRole("button", { name: "Remove money", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remove money", exact: true });
  await page.getByLabel("Amount in BDT", { exact: true }).fill("1.00");
  await page.setViewportSize({ width: 390, height: 330 });
  await expect.poll(async () => (await dialog.boundingBox())?.height).toBeLessThanOrEqual(330);
  const save = dialog.getByRole("button", { name: "Save removal", exact: true });
  await save.scrollIntoViewIfNeeded();
  await save.focus();
  const bounds = await save.boundingBox();
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(330);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Amount in BDT", { exact: true })).toHaveValue("1.00");
});
