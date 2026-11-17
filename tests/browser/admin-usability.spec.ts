import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { hashSessionToken } from "@/lib/auth-adapter";
import { SESSION_HEADER, startBrowserSessionProxy } from "../helpers/browser-session-proxy";
import { openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

let harness: PostgresTestHarness;
let proxy: Awaited<ReturnType<typeof startBrowserSessionProxy>>;
let administratorId: string;
let administratorToken: string;
let targetId: string;
const TARGET_EMAIL = "admin-task-member@example.test";

async function session(context: BrowserContext, token: string) {
  await context.setExtraHTTPHeaders({ [SESSION_HEADER]: token });
}
async function newSession(userId: string) {
  const token = randomUUID();
  await harness.db.session.create({ data: { userId, sessionToken: hashSessionToken(token), expires: new Date(Date.now() + 8 * 60 * 60_000) } });
  return token;
}
test.beforeAll(async () => {
  proxy = await startBrowserSessionProxy(process.env.E2E_BASE_URL!);
  harness = await openPostgresTestHarness();
});
test.beforeEach(async () => {
  await harness.clean();
  administratorId = (await harness.db.user.create({ data: { email: "admin-task-admin@example.test", name: "Task Administrator", status: "ACTIVE", role: "ADMIN", lastAuthenticatedAt: new Date() } })).id;
  targetId = (await harness.db.user.create({ data: { email: TARGET_EMAIL, name: "Task Member", status: "ACTIVE", role: "MEMBER" } })).id;
  administratorToken = await newSession(administratorId);
});
test.afterAll(async () => { await proxy?.close(); await harness?.close(); });

test("invitation success exposes the normalized identity and persisted expiry with selectable copy fallback", async ({ browser }) => {
  const context = await browser.newContext();
  await session(context, administratorToken);
  await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); } } }));
  try {
    const page = await context.newPage();
    await page.goto(`${proxy.origin}/admin`);
    await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
    await expect(page.getByLabel("Google account email", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Invitations", exact: true }).click();
    await expect(page.getByRole("article", { name: `Account ${TARGET_EMAIL}` })).toHaveCount(0);
    await page.getByLabel("Google account email", { exact: true }).fill("New.Invited@Example.Test");
    await page.getByLabel("Valid for", { exact: true }).selectOption("14");
    await page.getByRole("button", { name: "Review invitation", exact: true }).click();
    expect(await harness.db.invitation.count()).toBe(0);
    const dialog = page.getByRole("dialog", { name: "Create application access?" });
    await expect(dialog).toContainText("new.invited@example.test");
    await dialog.getByRole("button", { name: "Confirm invitation", exact: true }).click();
    const instructions = page.getByRole("region", { name: "Invitation access instructions" });
    await expect(instructions).toBeVisible();
    await expect(page.getByRole("region", { name: "Invitations", exact: true }).getByText("Invitation created. No email has been sent.", { exact: true })).toBeVisible();
    const stored = await harness.db.invitation.findUniqueOrThrow({ where: { email: "new.invited@example.test" } });
    expect(await instructions.locator("time").getAttribute("datetime")).toBe(stored.expiresAt.toISOString());
    await instructions.getByRole("button", { name: "Copy access instructions", exact: true }).click();
    const fallback = instructions.getByLabel("Access instructions to select and copy");
    await expect(fallback).toBeVisible();
    await expect(fallback).toBeFocused();
    const text = await fallback.inputValue();
    expect(text).toContain("new.invited@example.test");
    expect(text).toContain("No email has been sent");
    expect(text).toContain("Admin or Moderator must approve");
    const canonical = process.env.VERCEL === "1" ? process.env.AUTH_URL! : process.env.E2E_BASE_URL!;
    expect(text).toContain(new URL("/login", canonical).toString());
    expect(text).not.toContain(`${proxy.origin}/login`);
    const artifacts = resolve("docs/usability/screenshots/after");
    await mkdir(artifacts, { recursive: true });
    await instructions.screenshot({ path: join(artifacts, "invitation-access-instructions.png"), animations: "disabled" });
  } finally { await context.close(); }
});

test("task search survives switching/back navigation and a Global Moderator cannot open administration", async ({ browser }) => {
  const context = await browser.newContext();
  await session(context, administratorToken);
  try {
    const page = await context.newPage();
    await page.goto(`${proxy.origin}/admin`);
    await page.getByLabel("Search accounts", { exact: true }).fill(TARGET_EMAIL);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("article", { name: `Account ${TARGET_EMAIL}` })).toBeVisible();
    await page.getByRole("link", { name: "Invitations", exact: true }).click();
    await page.getByLabel("Search invitations", { exact: true }).fill("missing@example.test");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("link", { name: "Accounts", exact: true }).click();
    await expect(page.getByLabel("Search accounts", { exact: true })).toHaveValue(TARGET_EMAIL);
    await page.goBack();
    await expect(page.getByLabel("Search invitations", { exact: true })).toHaveValue("missing@example.test");
    await harness.db.user.update({ where: { id: targetId }, data: { role: "MODERATOR" } });
    const moderator = await browser.newContext();
    await session(moderator, await newSession(targetId));
    const denied = await moderator.newPage();
    await denied.goto(`${proxy.origin}/admin?view=invitations`);
    await expect(denied).toHaveURL(/\/groups(?:\?|$)/);
    await expect(denied.getByRole("heading", { name: "Invitations", exact: true })).toHaveCount(0);
    await moderator.close();
  } finally { await context.close(); }
});

test("stale privileged confirmation requires sign-out and a new confirmation after safe return", async ({ browser }) => {
  const context = await browser.newContext();
  await session(context, administratorToken);
  try {
    await harness.db.user.update({ where: { id: administratorId }, data: { lastAuthenticatedAt: new Date(Date.now() - 16 * 60_000) } });
    const page = await context.newPage();
    await page.goto(`${proxy.origin}/admin?view=accounts&accountsQ=${encodeURIComponent(TARGET_EMAIL)}`);
    const account = page.getByRole("article", { name: `Account ${TARGET_EMAIL}` });
    await account.getByRole("button", { name: "Disable account", exact: true }).click();
    expect((await harness.db.user.findUniqueOrThrow({ where: { id: targetId } })).status).toBe("ACTIVE");
    await page.getByRole("dialog", { name: "Disable this account?" }).getByRole("button", { name: "Confirm account disablement", exact: true }).click();
    await expect(account.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
    expect((await harness.db.user.findUniqueOrThrow({ where: { id: targetId } })).status).toBe("ACTIVE");
    await account.getByRole("button", { name: "Sign in again", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reauth=1&returnTo=/);
    const returnTo = new URL(page.url()).searchParams.get("returnTo")!;
    expect(returnTo).toBe(`/admin?view=accounts&accountsQ=${encodeURIComponent(TARGET_EMAIL)}`);
    expect(await harness.db.session.count({ where: { sessionToken: hashSessionToken(administratorToken) } })).toBe(0);
    await expect(page.getByText(/must review and confirm your change again/)).toBeVisible();
    await context.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, body: "Synthetic provider navigation; real Google callback is external validation." }));
    const authorization = page.waitForRequest((request) => new URL(request.url()).hostname === "accounts.google.com");
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await authorization;
    // Simulate only the post-provider session fixture, never authentication
    // freshness in application code. Real Google callbacks remain external.
    await harness.db.user.update({ where: { id: administratorId }, data: { lastAuthenticatedAt: new Date() } });
    await session(context, await newSession(administratorId));
    await page.goto(`${proxy.origin}${returnTo}`);
    expect((await harness.db.user.findUniqueOrThrow({ where: { id: targetId } })).status).toBe("ACTIVE");
    expect(await harness.db.auditEvent.count({ where: { action: "user.disabled" } })).toBe(0);
    await page.getByRole("article", { name: `Account ${TARGET_EMAIL}` }).getByRole("button", { name: "Disable account", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Disable this account?" })).toBeVisible();
    expect((await harness.db.user.findUniqueOrThrow({ where: { id: targetId } })).status).toBe("ACTIVE");
  } finally { await context.close(); }
});
