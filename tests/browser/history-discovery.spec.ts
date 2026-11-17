import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import { hashSessionToken } from "@/lib/auth-adapter";
import { getBusinessTodayDateInputValue, parseTransactionDateInput } from "@/lib/date-time";
import { normalizeHistoryFilters, type HistoryFilterInput } from "@/lib/history-filters";
import { formatCurrencyFromMinorUnits } from "@/lib/money";
import { SESSION_HEADER, startBrowserSessionProxy } from "../helpers/browser-session-proxy";
import { openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

// The browser calendar deliberately differs from the Asia/Dhaka business zone.
test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });

let harness: PostgresTestHarness;
let proxy: Awaited<ReturnType<typeof startBrowserSessionProxy>>;
let actorId: string;
let teamId: string;
let secondTeamId: string;
let today: string;
let now: Date;
const primaryName = "Discovery primary treasury";
const secondName = "Discovery second treasury";
const heldGates = new Set<() => void>();

type SeedEntry = { note: string; amountInCents: number; type?: "ADD" | "REMOVE"; date?: string; ageSeconds?: number };
function url(path: string) { return new URL(path, proxy.origin).toString(); }
function entries(page: Page) { return page.locator("[data-ledger-entry]:visible"); }
function isAction(request: Request) { return request.method() === "POST" && Boolean(request.headers()["next-action"]); }

async function seed(rows: SeedEntry[], target = teamId) {
  await harness.db.transaction.createMany({
    data: rows.map((row, index) => ({
      teamId: target,
      userId: actorId,
      actorIdSnapshot: actorId,
      actorNameSnapshot: "Discovery writer",
      idempotencyKey: randomUUID(),
      note: row.note,
      amountInCents: row.amountInCents,
      type: row.type ?? "ADD",
      transactionDate: parseTransactionDateInput(row.date ?? today),
      createdAt: new Date(now.getTime() - (row.ageSeconds ?? index + 1) * 1_000),
    })),
  });
}

async function apply(page: Page, filters: HistoryFilterInput) {
  if (filters.search !== undefined) await page.locator("#history-search").fill(filters.search);
  if (filters.direction) await page.locator("#history-direction").selectOption(filters.direction);
  if (filters.period) await page.locator("#history-period").selectOption(filters.period);
  if (filters.from !== undefined && filters.from !== null) await page.locator("#history-from").fill(filters.from);
  if (filters.to !== undefined && filters.to !== null) await page.locator("#history-to").fill(filters.to);
  const response = page.waitForResponse((value) => isAction(value.request()) && new URL(value.url()).pathname === `/dashboard/${teamId}`);
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await (await response).finished();
  await expect(page.getByRole("form", { name: "Transaction history filters" })).toHaveAttribute("aria-busy", "false");
}

async function matching(page: Page, count: number, added: number, removed: number) {
  await expect(page.getByText(`${count} matching · across the full ledger`, { exact: true })).toBeVisible();
  await expect(page.getByTestId("matching-added")).toHaveText(formatCurrencyFromMinorUnits(added));
  await expect(page.getByTestId("matching-removed")).toHaveText(formatCurrencyFromMinorUnits(removed));
  await expect(page.getByTestId("matching-net")).toHaveText(formatCurrencyFromMinorUnits(added - removed));
}

/** Delay genuine completed Server Action work; no product endpoint is mocked. */
async function holdNextAction(page: Page) {
  let ready!: () => void;
  let release!: () => void;
  let finished!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  heldGates.add(release);
  let claimed = false;
  const handler = async (route: Route) => {
    if (claimed || !isAction(route.request())) { await route.continue(); return; }
    claimed = true;
    try {
      const response = await route.fetch();
      ready();
      await gate;
      await route.fulfill({ response });
    } finally { finished(); }
  };
  await page.route("**/dashboard/**", handler);
  return {
    entered,
    async release() {
      release();
      await completed;
      heldGates.delete(release);
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
  now = new Date();
  today = getBusinessTodayDateInputValue(now);
  const actor = await harness.db.user.create({ data: { name: "Discovery writer", email: "discovery-writer@example.test", emailVerified: now, role: "ADMIN", status: "ACTIVE", lastAuthenticatedAt: now } });
  actorId = actor.id;
  const primary = await harness.db.team.create({ data: { name: primaryName, createdById: actorId } });
  const second = await harness.db.team.create({ data: { name: secondName, createdById: actorId } });
  teamId = primary.id;
  secondTeamId = second.id;
  await harness.db.teamMembership.createMany({ data: [teamId, secondTeamId].map((id) => ({ teamId: id, userId: actorId, role: "ADMIN" as const, status: "APPROVED" as const, approvedAt: now, approvedById: actorId })) });
  const token = `discovery-browser-${randomUUID()}`;
  await harness.db.session.create({ data: { userId: actorId, sessionToken: hashSessionToken(token), expires: new Date(now.getTime() + 60 * 60_000) } });
  await context.setExtraHTTPHeaders({ [SESSION_HEADER]: token });
});
test.afterEach(() => { for (const release of heldGates) release(); heldGates.clear(); });
test.afterAll(async () => { await proxy?.close(); await harness?.close(); });

test("searches beyond 25 visible rows and summarizes all matches before pagination", async ({ page }) => {
  await seed([
    ...Array.from({ length: 30 }, (_, index) => ({ note: `Noise ${index + 1}`, amountInCents: 100, ageSeconds: index + 1 })),
    ...Array.from({ length: 40 }, (_, index) => ({ note: `Receipt block ${index + 1}`, amountInCents: 200, type: index % 4 === 0 ? "REMOVE" as const : "ADD" as const, ageSeconds: index + 100 })),
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  await expect(entries(page)).toHaveCount(25);
  await expect(entries(page).filter({ hasText: "Receipt block" })).toHaveCount(0);
  let posts = 0;
  page.on("request", (request) => { if (isAction(request)) posts += 1; });
  await page.locator("#history-search").pressSequentially("Receipt block", { delay: 20 });
  await page.waitForTimeout(400);
  expect(posts).toBe(0);
  await apply(page, {});
  expect(posts).toBe(1);
  await matching(page, 40, 6_000, 2_000);
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(7_000));
  await expect(entries(page)).toHaveCount(25);
  await expect(entries(page).filter({ hasText: "Noise" })).toHaveCount(0);
  const screenshots = resolve("docs/usability/screenshots/after");
  await mkdir(screenshots, { recursive: true });
  // Actual 900px-high viewport excerpts, starting at History discovery. The
  // desktop view shows filter controls, authoritative summaries and table rows;
  // mobile shows the collapsed filter control, summaries and entry cards.
  await page.getByRole("region", { name: "History discovery", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: join(screenshots, "history-filtered-1280.png"), animations: "disabled" });
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.getByRole("button", { name: "Search and filters · Active", exact: true })).toBeVisible();
    await matching(page, 40, 6_000, 2_000);
    await page.getByRole("region", { name: "History discovery", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.screenshot({ path: join(screenshots, "history-filtered-390.png"), animations: "disabled" });
  } finally {
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await expect(page.getByText("40 loaded", { exact: true })).toBeVisible();
  await expect(entries(page)).toHaveCount(40);
  await matching(page, 40, 6_000, 2_000);
  await apply(page, { search: "no matching receipt exists" });
  await expect(page.getByRole("heading", { name: "No matching transactions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No transactions yet", exact: true })).toHaveCount(0);
  await matching(page, 0, 0, 0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  await expect(page.getByTestId("matching-net")).toHaveCount(0);
});

test("searches wildcard-looking note text literally through the real action", async ({ page }) => {
  await seed([
    ...Array.from({ length: 30 }, (_, index) => ({ note: `Ordinary entry ${index}`, amountInCents: 100 })),
    { note: "Literal 50%_\\receipt", amountInCents: 321, ageSeconds: 100 },
    { note: "Literal 50XXreceipt", amountInCents: 654, ageSeconds: 101 },
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  for (const search of ["%", "_", "\\", "50%_\\receipt"]) {
    await apply(page, { search });
    await expect(page.getByRole("status", { name: "Active transaction filters" })).toContainText(`Note contains: ${search}`);
    await matching(page, 1, 321, 0);
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page)).toContainText("Literal 50%_\\receipt");
  }
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(3_975));
});

test("validates direction, Dhaka months and inclusive ancient/custom date ranges on the server", async ({ page }) => {
  const current = normalizeHistoryFilters({ period: "THIS_MONTH" }, now);
  const previous = normalizeHistoryFilters({ period: "LAST_MONTH" }, now);
  await seed([
    { note: "Current addition", amountInCents: 1_500 },
    { note: "Current removal", amountInCents: 300, type: "REMOVE" },
    { note: "Current month first date", amountInCents: 100, date: current.from! },
    { note: "Previous addition", amountInCents: 900, date: previous.to! },
    { note: "Previous removal", amountInCents: 100, type: "REMOVE", date: previous.to! },
    { note: "Ancient addition", amountInCents: 25, date: "0001-01-01" },
    { note: "Ancient removal", amountInCents: 5, type: "REMOVE", date: "0099-01-01" },
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  await apply(page, { period: "THIS_MONTH" });
  await matching(page, 3, 1_600, 300);
  await expect(page.getByRole("status", { name: "Active transaction filters" })).toContainText(`${current.from} to ${current.to}`);
  await apply(page, { period: "LAST_MONTH" });
  await matching(page, 2, 900, 100);
  await apply(page, { direction: "REMOVE" });
  await matching(page, 1, 0, 100);
  await expect(entries(page)).toContainText("Previous removal");
  await apply(page, { direction: "ALL", period: "CUSTOM", from: "0001-01-01", to: "0099-01-01" });
  await matching(page, 2, 25, 5);
  await expect(entries(page)).toHaveCount(2);
  const previousUrl = page.url();
  const yesterday = parseTransactionDateInput(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const endBeforeStart = yesterday.toISOString().slice(0, 10);
  await apply(page, { from: today, to: endBeforeStart });
  await expect(page.locator("#history-to")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#history-to")).toBeFocused();
  await expect(page.getByText("The end date must be on or after the start date.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(previousUrl);
  await matching(page, 2, 25, 5);
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(2_120));
});

test("preserves safe back/forward filters without putting private search in URLs or browser storage", async ({ page }) => {
  const previous = normalizeHistoryFilters({ period: "LAST_MONTH" }, now);
  const privateSearch = "Private receipt";
  await seed([
    { note: `${privateSearch} current`, amountInCents: 100 },
    { note: `${privateSearch} removal`, amountInCents: 100, type: "REMOVE" },
    { note: `${privateSearch} previous`, amountInCents: 250, date: previous.to! },
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  await apply(page, { search: privateSearch, direction: "ADD", period: "THIS_MONTH" });
  await matching(page, 1, 100, 0);
  expect(new URL(page.url()).searchParams.get("period")).toBe("THIS_MONTH");
  await apply(page, { period: "LAST_MONTH" });
  await matching(page, 1, 250, 0);
  await page.goBack();
  await expect(page.locator("#history-period")).toHaveValue("THIS_MONTH");
  await matching(page, 1, 100, 0);
  await page.goForward();
  await expect(page.locator("#history-period")).toHaveValue("LAST_MONTH");
  await matching(page, 1, 250, 0);
  await expect(page.locator("#history-search")).toHaveValue(privateSearch);
  const actualUrl = new URL(page.url());
  for (const key of actualUrl.searchParams.keys()) expect(["direction", "period", "from", "to"]).toContain(key);
  expect([...actualUrl.searchParams.values()].join(" ")).not.toContain(privateSearch);
  const persistent = await page.evaluate(() => ({
    local: Object.keys(localStorage).map((key) => `${key}:${localStorage.getItem(key)}`).join(" "),
    session: Object.keys(sessionStorage).map((key) => `${key}:${sessionStorage.getItem(key)}`).join(" "),
    history: JSON.stringify(history.state),
  }));
  expect(persistent.local).not.toContain(privateSearch);
  expect(persistent.session).not.toContain(privateSearch);
  expect(persistent.history).not.toContain(privateSearch);
});

test("refreshes filtered summaries and pagination after another writer changes the ledger", async ({ page }) => {
  await seed([
    ...Array.from({ length: 28 }, (_, index) => ({ note: `Receipt ${index + 1}`, amountInCents: 100 })),
    { note: "Unmatched funding", amountInCents: 500 },
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  await apply(page, { search: "Receipt" });
  await matching(page, 28, 2_800, 0);
  await seed([{ note: "Receipt external writer", amountInCents: 200, ageSeconds: -1 }]);
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await matching(page, 29, 3_000, 0);
  await expect(page.getByText("25 loaded", { exact: true })).toBeVisible();
  await expect(entries(page).filter({ hasText: "Receipt external writer" })).toHaveCount(1);
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(3_500));
  await expect(page.locator("#history-search")).toHaveValue("Receipt");
});

test("does not mix a delayed old page into the next applied filter generation", async ({ page }) => {
  await seed([
    ...Array.from({ length: 30 }, (_, index) => ({ note: `Old batch ${index + 1}`, amountInCents: 100 })),
    { note: "New batch one", amountInCents: 50, type: "REMOVE" },
    { note: "New batch two", amountInCents: 50, type: "REMOVE" },
  ]);
  await page.goto(url(`/dashboard/${teamId}`));
  await apply(page, { search: "Old batch" });
  const old = await holdNextAction(page);
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await old.entered;
  await page.locator("#history-search").fill("New batch");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  // Next serializes actions. Release the older page, then verify the newer
  // authoritative filter generation replaces it rather than merging its rows.
  await old.release();
  await matching(page, 2, 0, 100);
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).filter({ hasText: "Old batch" })).toHaveCount(0);
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(2_900));
});

test("does not expose a delayed filtered page after browser history switches teams", async ({ page }) => {
  await seed(Array.from({ length: 30 }, (_, index) => ({ note: `Old filtered team ${index}`, amountInCents: 100 })));
  await seed([{ note: "Second team only", amountInCents: 5_000 }], secondTeamId);
  await page.goto(url(`/dashboard/${secondTeamId}`));
  await page.locator('a[href="/groups"]').first().click();
  await page.locator(`a[href="/dashboard/${teamId}"]:visible`).first().click();
  await apply(page, { search: "Old filtered team" });
  const old = await holdNextAction(page);
  await page.getByRole("button", { name: "Load more transactions", exact: true }).click();
  await old.entered;
  await page.goBack();
  await page.goBack();
  await old.release();
  await expect(page.getByRole("heading", { name: secondName, exact: true })).toBeVisible();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page)).toContainText("Second team only");
  await expect(entries(page).filter({ hasText: "Old filtered team" })).toHaveCount(0);
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(5_000));
  await expect(page.locator("#history-search")).toHaveValue("");
  await expect(page.getByTestId("matching-net")).toHaveCount(0);
});

test("confirms a filtered-out save while retaining filters and authoritative all-time totals", async ({ page }) => {
  await seed([{ note: "Starting funding", amountInCents: 1_000 }]);
  await page.goto(url(`/dashboard/${teamId}`));
  await apply(page, { search: "approved only", direction: "REMOVE" });
  await matching(page, 0, 0, 0);
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  const entry = page.getByRole("dialog", { name: "Add money", exact: true });
  await expect(entry).toBeVisible();
  await expect(entry.locator("#type")).toHaveValue("ADD");
  await entry.getByLabel("Amount in BDT", { exact: true }).fill("2.50");
  await entry.locator("#note").fill("Saved outside filter");
  await entry.getByRole("button", { name: "Save addition", exact: true }).click();
  await expect(entry).not.toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "outside the current filters or first page" })).toBeVisible();
  await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(1_250));
  await matching(page, 0, 0, 0);
  await expect(page.locator("#history-search")).toHaveValue("approved only");
  await expect(page.locator("#history-direction")).toHaveValue("REMOVE");
  await expect(entries(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(entries(page).filter({ hasText: "Saved outside filter" })).toHaveCount(1);
  await expect(entries(page)).toHaveCount(2);
  expect(await harness.db.transaction.count({ where: { teamId, note: "Saved outside filter" } })).toBe(1);
});
