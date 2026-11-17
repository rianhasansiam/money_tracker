import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { bootstrapAdmin, createPrismaAdminBootstrapRepository } from "@/lib/admin-bootstrap";
import { hashSessionToken } from "@/lib/auth-adapter";
import { getBusinessTodayDateInputValue, parseTransactionDateInput } from "@/lib/date-time";
import { formatCurrencyFromMinorUnits, formatSignedCurrency } from "@/lib/money";
import {
  SESSION_HEADER,
  startBrowserSessionProxy,
} from "../helpers/browser-session-proxy";
import {
  openPostgresTestHarness,
  type PostgresTestHarness,
} from "../helpers/postgres-test-harness";
import { validateTestDatabaseEnvironment } from "../helpers/test-database-safety";

const WIDTHS = [320, 390, 768, 1024, 1440];
const ARTIFACTS = resolve("docs/usability/screenshots/after");
const FUNDING_CENTS = 2_147_483_647;
const EXPENSE_CENTS = 10_001;
const ADMIN_EMAIL = "responsive-admin@example.test";
const MEMBER_EMAIL = "responsive-member@example.test";
const checks: Array<Record<string, unknown>> = [];
const limitations = [
  "The controlled fault check targets the actual dashboard loading and recovery boundary; unrelated global error boundaries are not fault-injected.",
  "Synthetic sessions exercise authorized pages; real Google callbacks and assistive-technology sessions require deployment validation.",
];

let harness: PostgresTestHarness;
let proxy: Awaited<ReturnType<typeof startBrowserSessionProxy>>;
let adminToken: string;
let memberToken: string;
let ledgerTeamId: string;
let emptyTeamId: string;
let ledgerTeamName: string;
let approvedConnectionString: string;

function browserUrl(path: string) {
  return new URL(path, proxy.origin).toString();
}

async function setSession(context: BrowserContext, token?: string) {
  await context.clearCookies();
  await context.setExtraHTTPHeaders(token ? { [SESSION_HEADER]: token } : {});
}

async function persistChecks() {
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(join(ARTIFACTS, "responsive-matrix.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    widths: WIDTHS,
    checks,
    limitations,
  }, null, 2));
}

test.beforeAll(async () => {
  if (!process.env.E2E_BASE_URL) throw new Error("E2E_BASE_URL is required.");
  // Capture approval before the harness deliberately maps DATABASE_URL to its
  // leased disposable target for application-service imports in this worker.
  approvedConnectionString = validateTestDatabaseEnvironment().connectionString;
  proxy = await startBrowserSessionProxy(process.env.E2E_BASE_URL);
  harness = await openPostgresTestHarness();
  await harness.clean();
  const now = new Date();
  await bootstrapAdmin(createPrismaAdminBootstrapRepository(harness.db), ADMIN_EMAIL);
  const admin = await harness.db.user.update({
    where: { email: ADMIN_EMAIL },
    data: { name: "Responsive Administrator", lastAuthenticatedAt: now },
  });
  const member = await harness.db.user.create({
    data: {
      name: "Responsive Member",
      email: MEMBER_EMAIL,
      emailVerified: now,
      status: "ACTIVE",
      lastAuthenticatedAt: now,
    },
  });
  for (let index = 0; index < 20; index += 1) {
    const name = `Responsive group ${String(index + 1).padStart(2, "0")} ${"longname".repeat(7)}`;
    const team = await harness.db.team.create({
      data: {
        name,
        description: "Synthetic long group description for narrow-screen wrapping and tall-list dialog coverage. ".repeat(2),
        createdById: admin.id,
      },
    });
    await harness.db.teamMembership.create({
      data: {
        teamId: team.id,
        userId: admin.id,
        role: "ADMIN",
        status: "APPROVED",
        approvedAt: now,
        approvedById: admin.id,
      },
    });
    if (index === 0) {
      ledgerTeamId = team.id;
      ledgerTeamName = team.name;
      await harness.db.teamMembership.create({
        data: {
          teamId: team.id,
          userId: member.id,
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
      });
    }
  }
  const emptyTeam = await harness.db.team.create({
    data: { name: "Responsive empty ledger", createdById: admin.id },
  });
  emptyTeamId = emptyTeam.id;
  await harness.db.teamMembership.create({
    data: {
      teamId: emptyTeamId,
      userId: admin.id,
      role: "ADMIN",
      status: "APPROVED",
      approvedAt: now,
      approvedById: admin.id,
    },
  });
  await harness.db.transaction.createMany({
    data: [
      { type: "ADD" as const, amountInCents: FUNDING_CENTS, note: "Synthetic funding with a full-sized permitted financial amount" },
      { type: "REMOVE" as const, amountInCents: EXPENSE_CENTS, note: "Synthetic expense " + "unbrokentext".repeat(18) },
    ].map((entry) => ({
      ...entry,
      teamId: ledgerTeamId,
      userId: admin.id,
      idempotencyKey: randomUUID(),
      actorIdSnapshot: admin.id,
      actorNameSnapshot: "Responsive Administrator",
      transactionDate: parseTransactionDateInput(getBusinessTodayDateInputValue()),
    })),
  });
  const requester = await harness.db.user.create({
    data: { name: "Responsive requester", email: "responsive-request@example.test", status: "ACTIVE", emailVerified: now },
  });
  await harness.db.teamMembership.create({
    data: { teamId: ledgerTeamId, userId: requester.id, role: "MEMBER", status: "PENDING" },
  });
  adminToken = `responsive-admin-${randomUUID()}`;
  memberToken = `responsive-member-${randomUUID()}`;
  await harness.db.session.createMany({
    data: [
      { userId: admin.id, sessionToken: hashSessionToken(adminToken) },
      { userId: member.id, sessionToken: hashSessionToken(memberToken) },
    ].map((session) => ({ ...session, expires: new Date(now.getTime() + 60 * 60_000) })),
  });
});

test.afterAll(async () => {
  await persistChecks();
  await proxy?.close();
  await harness?.close();
});

async function textContrast(locator: Locator) {
  const ratio = await locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas color conversion is unavailable.");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
    for (const ancestor of ancestors) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    const luminance = (color: number[]) => {
      const [red, green, blue] = color.map((component) => {
        const channel = component / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const a = luminance(background);
    const b = luminance(foreground);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio, "Rendered financial and primary-action text contrast").toBeGreaterThanOrEqual(4.5);
  return ratio;
}

async function inspectLayout(page: Page, screen: string, width: number, zoom = 1) {
  await expect(page.getByRole("main")).toHaveCount(1);
  if (screen === "dashboard-loading") {
    await expect(page.getByRole("status").filter({ hasText: "Loading the financial dashboard" })).toBeVisible();
  } else await expect(page.getByRole("heading").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    devicePixelRatio,
  }));
  const overflow = dimensions.documentWidth > dimensions.innerWidth + 1
    ? await page.locator("main *").evaluateAll((elements) => elements.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && bounds.height && (bounds.right > innerWidth + 1 || bounds.left < -1)
        ? [{ tag: element.tagName, id: element.id, class: typeof element.className === "string" ? element.className.slice(0, 100) : "", right: bounds.right, width: bounds.width, text: element.textContent?.slice(0, 80) }]
        : [];
    }).sort((a, b) => b.right - a.right).slice(0, 8))
    : [];
  expect(dimensions.documentWidth, `${screen}: document overflow at ${width}px/${zoom * 100}% ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(dimensions.innerWidth + 1);
  expect(dimensions.bodyWidth, `${screen}: body overflow at ${width}px/${zoom * 100}%`).toBeLessThanOrEqual(dimensions.innerWidth + 1);
  const unlabeled = await page.locator("input:visible, textarea:visible, select:visible, [role=combobox]:visible").evaluateAll((elements) => elements.flatMap((element) => {
    // Radix keeps an aria-hidden native select for form submission; the
    // visible, label-associated combobox is its accessible interaction surface.
    if (element.closest('[aria-hidden="true"]')) return [];
    const associated = "labels" in element && Array.from((element as HTMLInputElement).labels ?? []).some((label) => label.textContent?.trim());
    const described = element.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim());
    return associated || described || element.getAttribute("aria-label")?.trim() ? [] : [element.id || element.tagName];
  }));
  expect(unlabeled, `${screen}: every visible form control needs a persistent label`).toEqual([]);
  const buttonTargets = await page.locator('[data-slot="button"]:visible').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      name: element.getAttribute("aria-label") || element.textContent?.trim(),
      tag: element.tagName,
      width: bounds.width,
      height: bounds.height,
      computedHeight: style.height,
      minHeight: style.minHeight,
      flexBasis: style.flexBasis,
      flexGrow: style.flexGrow,
      flexShrink: style.flexShrink,
      lineHeight: style.lineHeight,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  }));
  const undersizedButtons = buttonTargets.filter((button) => button.height < 44);
  if (undersizedButtons.length) {
    checks.push({ screen, viewportWidth: width, nativeZoom: zoom, status: "failed", buttonTargetsBelow44CssPixels: undersizedButtons });
    await persistChecks();
  }
  expect(undersizedButtons, `${screen}: visible shared buttons and links need 44 CSS pixel touch targets`).toEqual([]);
  const contrastRatios: number[] = [];
  if (screen === "login" || screen === "login-rate-limited") {
    const signIn = page.getByRole("button", { name: "Continue with Google", exact: true });
    await expect(signIn).toBeVisible();
    expect((await signIn.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    contrastRatios.push(await textContrast(signIn));
    if (screen === "login-rate-limited") {
      await expect(page.getByRole("main").getByRole("alert")).toContainText("42 seconds");
    }
  }
  if (["dashboard", "member-dashboard", "empty-dashboard", "groups", "teams-approvals", "admin", "admin-no-results", "invitations-no-results", "access-no-results"].includes(screen)) {
    const nav = page.getByRole("navigation", { name: "Workspace" });
    await expect(nav).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    contrastRatios.push(await textContrast(nav.locator('[aria-current="page"]')));
    if (screen === "groups" || screen === "teams-approvals") {
      const badge = page.locator('nav[aria-label="Teams views"] a > span:nth-of-type(2)');
      await expect(badge).toHaveCount(1);
      contrastRatios.push(await textContrast(badge));
    }
    if (screen === "member-dashboard") {
      await expect(nav.getByRole("link", { name: "Administration" })).toHaveCount(0);
      await expect(page.getByText("View-only access.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save addition", exact: true })).toHaveCount(0);
    }
    await page.keyboard.press("Tab");
    await nav.getByRole("link", { name: "Teams", exact: true }).focus();
    const focusStyle = await nav.getByRole("link", { name: "Teams", exact: true }).evaluate((element) => ({
      width: Number.parseFloat(getComputedStyle(element).outlineWidth),
      style: getComputedStyle(element).outlineStyle,
    }));
    expect(focusStyle.style).not.toBe("none");
    expect(focusStyle.width).toBeGreaterThanOrEqual(2);
  }
  if (screen === "dashboard" || screen === "member-dashboard") {
    await expect(page.getByRole("heading", { name: ledgerTeamName, exact: true })).toBeVisible();
    await expect(page.getByTestId("team-balance")).toHaveText(formatCurrencyFromMinorUnits(FUNDING_CENTS - EXPENSE_CENTS));
    for (const amount of [formatSignedCurrency(FUNDING_CENTS, "ADD"), formatSignedCurrency(EXPENSE_CENTS, "REMOVE")]) {
      const value = page.getByText(amount, { exact: true }).filter({ visible: true });
      await expect(value).toHaveCount(1);
      contrastRatios.push(await textContrast(value));
      await value.scrollIntoViewIfNeeded();
      const metrics = await value.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const bounds = range.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: bounds.left, right: bounds.right, width: innerWidth, overflow: style.textOverflow, clamp: style.webkitLineClamp };
      });
      expect(metrics.overflow).not.toBe("ellipsis");
      expect(["none", "0"]).toContain(metrics.clamp);
      expect(metrics.left).toBeGreaterThanOrEqual(-1);
      expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1);
    }
  }
  if (screen === "empty-dashboard") await expect(page.getByRole("heading", { name: "No transactions yet" })).toBeVisible();
  if (["admin-no-results", "invitations-no-results", "access-no-results"].includes(screen)) {
    const name = screen === "admin-no-results" ? "No matching accounts" : screen === "invitations-no-results" ? "No matching invitations" : "No matching team access & ownership";
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  checks.push({ screen, viewportWidth: width, nativeZoom: zoom, ...dimensions, contrastRatios, buttonTargetsChecked: buttonTargets.length, minimumButtonHeight: buttonTargets.length ? Math.min(...buttonTargets.map((button) => button.height)) : null, dashboardLinkTarget: buttonTargets.find((button) => button.name === "Open team") ?? null, status: "passed" });
  await persistChecks();
}

async function inspectTransactionEntry(page: Page, width: number, zoom = 1) {
  await page.getByRole("button", { name: "Add money", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add money", exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const bounds = await dialog.boundingBox();
  expect(bounds).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await expect(dialog.getByLabel("Amount in BDT", { exact: true })).toHaveAttribute("inputmode", "decimal");
  await expect(dialog.getByLabel("Transaction date", { exact: true })).toHaveAttribute("min", "0001-01-01");
  await expect(dialog.locator("#type")).toHaveValue("ADD");
  const unlabeled = await dialog.locator("input:visible, textarea:visible, select:visible").evaluateAll((elements) => elements.filter((element) => !("labels" in element && (element as HTMLInputElement).labels?.length)).map((element) => element.id));
  expect(unlabeled).toEqual([]);
  await dialog.getByLabel("Transaction date", { exact: true }).fill("0001-01-01");
  await dialog.getByLabel("Note", { exact: false }).fill("A".repeat(240));
  await expect(dialog.getByText("240/240 characters", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save addition", exact: true }).scrollIntoViewIfNeeded();
  const panel = dialog.locator(":scope > div");
  expect(await panel.evaluate((element) => element.clientHeight <= innerHeight && element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
  if ([390, 1440].includes(width) && zoom === 1) await page.screenshot({ path: join(ARTIFACTS, `transaction-entry-${width}.png`), animations: "disabled" });
  await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(dialog.getByText("Discard this unsaved input? No entry will be submitted.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(dialog.getByLabel("Note", { exact: false })).toHaveValue("");
  await dialog.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Remove money", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Remove money", exact: true });
  await expect(removal.locator("#type")).toHaveValue("REMOVE");
  await removal.getByRole("button", { name: "Save removal", exact: true }).scrollIntoViewIfNeeded();
  await expect(removal.getByRole("button", { name: "Save removal", exact: true })).toBeVisible();
  await removal.getByRole("button", { name: "Close transaction entry", exact: true }).click();
  checks.push({ screen: "transaction-entry", viewportWidth: width, nativeZoom: zoom, viewport, bounds, fullSupportedDateRange: true, noteCounter: true, labels: true, preselectedDirections: ["ADD", "REMOVE"], status: "passed" });
  await persistChecks();
}

function screens() {
  return [
    { name: "login", path: "/login", actor: "anonymous" },
    { name: "login-rate-limited", path: "/login?authError=rate_limited&retryAfter=42", actor: "anonymous" },
    { name: "admission-error", path: "/auth-error", actor: "anonymous" },
    { name: "not-found", path: "/responsive-missing-page", actor: "anonymous" },
    { name: "dashboard", path: `/dashboard/${ledgerTeamId}`, actor: "admin" },
    { name: "empty-dashboard", path: `/dashboard/${emptyTeamId}`, actor: "admin" },
    { name: "member-dashboard", path: `/dashboard/${ledgerTeamId}`, actor: "member" },
    { name: "groups", path: "/groups", actor: "admin" },
    { name: "teams-approvals", path: "/groups?view=approvals", actor: "admin" },
    { name: "admin", path: "/admin", actor: "admin" },
    { name: "admin-no-results", path: "/admin?view=accounts&accountsQ=no-synthetic-record-matches-this-query", actor: "admin" },
    { name: "invitations-no-results", path: "/admin?view=invitations&invitationsQ=no-synthetic-record-matches-this-query", actor: "admin" },
    { name: "access-no-results", path: "/admin?view=access&accessQ=no-synthetic-record-matches-this-query", actor: "admin" },
  ];
}

test("existing screens remain usable across the responsive width matrix", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = {
    anonymous: await browser.newContext({ reducedMotion: "reduce" }),
    admin: await browser.newContext({ reducedMotion: "reduce" }),
    member: await browser.newContext({ reducedMotion: "reduce" }),
  };
  await setSession(contexts.admin, adminToken);
  await setSession(contexts.member, memberToken);
  const pages = {
    anonymous: await contexts.anonymous.newPage(),
    admin: await contexts.admin.newPage(),
    member: await contexts.member.newPage(),
  };
  try {
    for (const width of WIDTHS) {
      for (const screen of screens()) {
        const page = pages[screen.actor as keyof typeof pages];
        await page.setViewportSize({ width, height: 900 });
        await page.goto(browserUrl(screen.path));
        await inspectLayout(page, screen.name, width);
        if (screen.name === "dashboard") await inspectTransactionEntry(page, width);
        if ([390, 1440].includes(width) && ["login", "dashboard", "groups", "admin"].includes(screen.name)) {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: join(ARTIFACTS, `${screen.name}-${width}.png`), animations: "disabled" });
        }
      }
    }
  } finally {
    await Promise.all(Object.values(contexts).map((context) => context.close()));
  }
});

test("native quarantine dialog covers the viewport and contains keyboard and pending interaction", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 320, height: 480 }, reducedMotion: "reduce" });
  await setSession(context, adminToken);
  const page = await context.newPage();
  let releaseHeld: () => void = () => undefined;
  try {
    await page.goto(browserUrl("/groups"));
    const management = page.locator("summary").filter({ hasText: "Team management" });
    await expect(management).toHaveCount(20);
    await management.last().click();
    const trigger = page.getByRole("button", { name: "Quarantine team", exact: true }).filter({ visible: true }).last();
    await expect(page.getByRole("button", { name: "Quarantine team", exact: true }).filter({ visible: true })).toHaveCount(1);
    await trigger.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(1_000);
    const backgroundScrollY = await page.evaluate(() => scrollY);
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(/does not permanently delete/);
    const bounds = await dialog.boundingBox();
    expect(bounds).toMatchObject({ x: 0, y: 0, width: 320, height: 480 });
    expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await page.mouse.move(4, 4);
    await page.mouse.wheel(0, 600);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => scrollY)).toBe(backgroundScrollY);
    const title = await dialog.getByRole("heading").innerText();
    const teamName = title.replace(/^Quarantine /, "").replace(/\?$/, "");
    await dialog.getByRole("textbox").fill(teamName);
    const focusSequence: Array<Record<string, unknown>> = [];
    for (const key of [...Array(8).fill("Tab"), ...Array(8).fill("Shift+Tab")]) {
      await page.keyboard.press(key);
      const focused = await dialog.evaluate((element) => ({
        inside: element.contains(document.activeElement),
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
        text: document.activeElement?.textContent?.slice(0, 100),
      }));
      focusSequence.push({ key, ...focused });
      expect(focused.inside, `Focus after ${key}: ${JSON.stringify(focused)}`).toBe(true);
    }
    await page.locator('nav[aria-label="Workspace"] a[href="/groups"]').evaluate((element) => (element as HTMLElement).focus());
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const panel = dialog.locator(":scope > div");
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await dialog.getByRole("button", { name: "Quarantine for 30 days", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(ARTIFACTS, "quarantine-dialog-320.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 1440, height: 900 });
    await trigger.click();
    await expect(dialog).toBeVisible();
    const desktopBounds = await dialog.boundingBox();
    expect(desktopBounds).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
    await page.screenshot({ path: join(ARTIFACTS, "quarantine-dialog-1440.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 320, height: 480 });
    await trigger.click();
    await dialog.getByRole("textbox").fill(teamName);
    let starts = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const routeHandler = async (route: Route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        starts += 1;
        markStarted();
        await held;
        await route.abort("failed");
      } else await route.continue();
    };
    await page.route("**/groups**", routeHandler);
    await dialog.getByRole("button", { name: "Quarantine for 30 days", exact: true }).click();
    await started;
    await expect(dialog.getByRole("button", { name: "Quarantining...", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Keep team", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("textbox")).toBeDisabled();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const pendingFocus = await dialog.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id }));
    await dialog.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    releaseHeld();
    await expect(dialog.getByRole("alert")).toContainText("Refresh the page before trying again");
    await expect(dialog.getByRole("textbox")).toHaveValue(teamName);
    expect(starts).toBe(1);
    await page.unroute("**/groups**", routeHandler);
    await dialog.getByRole("button", { name: "Keep team", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    checks.push({ screen: "quarantine-dialog", viewportWidth: 320, viewportHeight: 480, bounds, desktopBounds, nativeModal: true, focusContained: true, focusSequence, pendingFocus, backgroundScrollLocked: true, pendingDuplicateRequests: starts, recoverableNetworkFailure: true, status: "passed" });
    await persistChecks();
  } finally {
    releaseHeld();
    await context.close();
  }
});

test("actual browser 200 percent zoom preserves layout and visible money", async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "money-tracker-native-zoom-"));
  const extension = join(directory, "extension");
  let context: BrowserContext | undefined;
  await mkdir(extension);
  await writeFile(join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Money Tracker native zoom regression",
    version: "1.0",
    permissions: ["tabs"],
    background: { service_worker: "background.js" },
  }));
  await writeFile(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});");
  try {
    context = await chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium",
      headless: true,
      reducedMotion: "reduce",
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    let page = context.pages()[0] ?? await context.newPage();
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of screens()) {
        // Close the previous document before replacing its synthetic identity.
        // Otherwise late prefetch renewal cookies can race clearCookies().
        await page.close();
        await setSession(context, screen.actor === "admin" ? adminToken : screen.actor === "member" ? memberToken : undefined);
        page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        await page.goto(browserUrl(screen.path));
        const zoom = await worker.evaluate(async (origin) => {
          const api = (globalThis as unknown as { chrome: { tabs: {
            query(options: { url: string }): Promise<Array<{ id?: number }>>;
            setZoom(id: number, zoom: number): Promise<void>;
            getZoom(id: number): Promise<number>;
          } } }).chrome.tabs;
          const [tab] = await api.query({ url: `${origin}/*` });
          if (tab?.id === undefined) throw new Error("The native zoom tab was not found.");
          await api.setZoom(tab.id, 2);
          return api.getZoom(tab.id);
        }, proxy.origin);
        expect(zoom).toBe(2);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width / 2);
        await inspectLayout(page, screen.name, width, zoom);
        if (screen.name === "dashboard") await inspectTransactionEntry(page, width, zoom);
        if (width === 1440 && screen.name === "dashboard") {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: join(ARTIFACTS, "dashboard-1440-native-200-percent.png"), animations: "disabled" });
        }
      }
    }
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real dashboard loading, query failure, and retry stay recoverable", async ({ browser }) => {
  test.setTimeout(30_000);
  const lock = new Client({
    connectionString: approvedConnectionString,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 3_000,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
  await setSession(context, adminToken);
  const page = await context.newPage();
  let releasePromise: Promise<unknown> | undefined;
  const unlock = () => releasePromise ??= lock.query("ROLLBACK");
  let safety: ReturnType<typeof setTimeout> | undefined;
  try {
    await lock.connect();
    await lock.query("BEGIN");
    // This connection targets only the verified, exclusively leased disposable
    // database. Block its read briefly to observe the real streamed fallback.
    await lock.query('LOCK TABLE "Team" IN ACCESS EXCLUSIVE MODE');
    safety = setTimeout(() => { void unlock().catch(() => undefined); }, 8_000);
    await page.goto(browserUrl(`/dashboard/${ledgerTeamId}`), { waitUntil: "commit" });
    await inspectLayout(page, "dashboard-loading", 390);
    await page.screenshot({ path: join(ARTIFACTS, "dashboard-loading-390.png"), animations: "disabled" });

    let waitingPids: number[] = [];
    await expect.poll(async () => {
      const rows = await harness.db.$queryRaw<Array<{ pid: number }>>`
        SELECT DISTINCT pid FROM pg_locks
        WHERE NOT granted AND pid <> pg_backend_pid()
          AND relation IN (
            SELECT relation.oid FROM pg_class AS relation
            JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
            WHERE relation.relname = 'Team' AND schema.nspname = current_schema()
          )
      `;
      waitingPids = rows.map((row) => row.pid);
      return waitingPids.length;
    }, { timeout: 3_000 }).toBe(1);
    const cancellation = await harness.db.$queryRaw<Array<{ cancelled: boolean }>>`
      SELECT pg_cancel_backend(${waitingPids[0]}) AS cancelled
    `;
    expect(cancellation).toEqual([{ cancelled: true }]);
    await unlock();
    if (safety) clearTimeout(safety);

    await expect(page.getByRole("heading", { name: "The dashboard could not be loaded", exact: true })).toBeVisible();
    await inspectLayout(page, "dashboard-error", 390);
    await page.screenshot({ path: join(ARTIFACTS, "dashboard-recovery-390.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await inspectLayout(page, "dashboard", 390);
    await expect(harness.db.transaction.count({ where: { teamId: ledgerTeamId } })).resolves.toBe(2);
    checks.push({ screen: "dashboard-recovery", actualLoadingBoundary: true, cancelledBlockedRequests: 1, retrySucceeded: true, financialRowsUnchanged: true, status: "passed" });
    await persistChecks();
  } finally {
    if (safety) clearTimeout(safety);
    await unlock().catch(() => undefined);
    await lock.end();
    await context.close();
  }
});
