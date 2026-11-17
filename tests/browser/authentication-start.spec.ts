import { expect, test } from "@playwright/test";
import { startBrowserSessionProxy } from "../helpers/browser-session-proxy";
import { openPostgresTestHarness } from "../helpers/postgres-test-harness";

test("the real Google sign-in form consumes the shared start quota once", async ({ browser }) => {
  const harness = await openPostgresTestHarness();
  const proxy = await startBrowserSessionProxy(process.env.E2E_BASE_URL!);
  const context = await browser.newContext();
  try {
    await harness.clean();
    // No real Google identity/callback: capture the outgoing authorization URL.
    await context.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, body: "Synthetic OAuth navigation intercepted." }));
    const page = await context.newPage();
    await page.goto(`${proxy.origin}/login`);
    const authorization = page.waitForRequest((request) => new URL(request.url()).hostname === "accounts.google.com");
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await authorization;
    const buckets = await harness.db.rateLimitBucket.findMany({
      where: { scope: "authentication-start" }, select: { count: true },
    });
    expect(buckets).toEqual([{ count: 1 }]);
  } finally {
    await context.close();
    await proxy.close();
    await harness.close();
  }
});
