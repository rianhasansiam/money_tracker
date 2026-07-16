import { randomUUID } from "node:crypto";
import {
  createServer,
  request as requestUpstream,
  type Server,
} from "node:http";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  bootstrapAdmin,
  createPrismaAdminBootstrapRepository,
} from "@/lib/admin-bootstrap";
import { hashSessionToken } from "@/lib/auth-adapter";
import { getBusinessTodayDateInputValue, parseTransactionDateInput } from "@/lib/date-time";
import {
  admitInvitedGoogleIdentity,
  createPrismaInvitationRepository,
  provisionInvitation,
} from "@/lib/invitations";
import {
  openPostgresTestHarness,
  type PostgresTestHarness,
} from "../helpers/postgres-test-harness";

const TEAM_NAME = "Browser Workflow Treasury";
const ADMIN_EMAIL = "browser-admin@example.test";
const MEMBER_EMAIL = "browser-member@example.test";

let harness: PostgresTestHarness;
let administratorId: string;
let administratorToken: string;
let browserOrigin: string;
let memberId: string;
let memberToken: string;
let sessionProxy: Server;

function requireBaseUrl() {
  const configured = process.env.E2E_BASE_URL?.trim();

  if (!configured) {
    throw new Error("E2E_BASE_URL is required for browser tests.");
  }

  const url = new URL(configured);

  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("E2E_BASE_URL must be a loopback HTTP origin.");
  }

  return url;
}

async function startSessionProxy() {
  const upstream = requireBaseUrl();
  sessionProxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    const rawToken = headers["x-money-tracker-test-session"];
    delete headers["x-money-tracker-test-session"];

    if (typeof rawToken === "string") {
      const encodedToken = encodeURIComponent(rawToken);
      headers.cookie = [
        `authjs.session-token=${encodedToken}`,
        `__Secure-authjs.session-token=${encodedToken}`,
      ].join("; ");
    }

    const upstreamRequest = requestUpstream(
      new URL(incoming.url ?? "/", upstream),
      {
        method: incoming.method,
        headers,
      },
      (upstreamResponse) => {
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(outgoing);
      },
    );

    upstreamRequest.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain" });
      }
      outgoing.end("Test proxy upstream unavailable.");
    });
    incoming.pipe(upstreamRequest);
  });

  await new Promise<void>((resolve, reject) => {
    sessionProxy.once("error", reject);
    sessionProxy.listen(0, "127.0.0.1", () => {
      sessionProxy.off("error", reject);
      resolve();
    });
  });

  const address = sessionProxy.address();
  if (!address || typeof address === "string") {
    throw new Error("The browser session proxy did not bind to loopback.");
  }

  browserOrigin = `http://127.0.0.1:${address.port}`;
}

function browserUrl(pathname: string) {
  return new URL(pathname, browserOrigin).toString();
}

async function useSession(context: BrowserContext, rawToken: string) {
  await context.setExtraHTTPHeaders({
    "x-money-tracker-test-session": rawToken,
  });
}

test.beforeAll(async () => {
  await startSessionProxy();
  harness = await openPostgresTestHarness();
  await harness.clean();

  const now = new Date();
  const bootstrapRepository = createPrismaAdminBootstrapRepository(harness.db);
  await expect(
    bootstrapAdmin(bootstrapRepository, ADMIN_EMAIL),
  ).resolves.toEqual({ status: "created" });

  const administrator = await harness.db.user.update({
    where: { email: ADMIN_EMAIL },
    data: {
      name: "Browser Workflow Administrator",
      lastAuthenticatedAt: now,
    },
  });
  administratorId = administrator.id;

  const invitationRepository = createPrismaInvitationRepository(harness.db);
  await expect(
    admitInvitedGoogleIdentity(
      invitationRepository,
      "unprovisioned-browser-user@example.test",
      now,
    ),
  ).resolves.toBe(false);
  await provisionInvitation(invitationRepository, {
    actorUserId: administrator.id,
    email: MEMBER_EMAIL,
    now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
  });
  await expect(
    admitInvitedGoogleIdentity(
      invitationRepository,
      MEMBER_EMAIL,
      new Date(now.getTime() + 1_000),
    ),
  ).resolves.toBe(true);

  const member = await harness.db.user.update({
    where: { email: MEMBER_EMAIL },
    data: {
      name: "Browser Workflow Member",
      lastAuthenticatedAt: now,
    },
  });
  memberId = member.id;
  administratorToken = `browser-admin-${randomUUID()}`;
  memberToken = `browser-member-${randomUUID()}`;
  const expires = new Date(now.getTime() + 60 * 60 * 1_000);

  await harness.db.session.createMany({
    data: [
      {
        sessionToken: hashSessionToken(administratorToken),
        userId: administrator.id,
        expires,
      },
      {
        sessionToken: hashSessionToken(memberToken),
        userId: member.id,
        expires,
      },
    ],
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    sessionProxy?.close(() => resolve());
  });
  await harness?.close();
});

test("completes the critical lifecycle through the production UI", async ({
  browser,
}) => {
  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(browserUrl("/login"));
  await expect(
    anonymousPage.getByRole("heading", { name: "Sign in to Money Tracker" }),
  ).toBeVisible();
  await anonymousContext.close();

  const administratorContext = await browser.newContext();
  await useSession(administratorContext, administratorToken);
  const administratorSessionResponse = await administratorContext.request.get(
    browserUrl("/api/auth/session"),
  );
  expect(administratorSessionResponse.ok()).toBe(true);
  expect(await administratorSessionResponse.json()).toHaveProperty("user");
  const administratorPage = await administratorContext.newPage();
  await administratorPage.goto(browserUrl("/groups"));
  await expect(
    administratorPage.getByRole("button", {
      name: "Create team",
      exact: true,
    }),
  ).toBeVisible();

  await administratorPage.getByLabel("Team name").fill(TEAM_NAME);
  await administratorPage
    .getByLabel("Description")
    .fill("Production browser workflow fixture");
  await administratorPage
    .getByRole("button", { name: "Create team", exact: true })
    .click();
  await administratorPage.waitForURL(/\/dashboard\/[a-z0-9]+$/);
  const teamId = new URL(administratorPage.url()).pathname.split("/").at(-1);
  expect(teamId).toBeTruthy();
  if (!teamId) {
    throw new Error("The browser team workflow did not return a team ID.");
  }

  const memberContext = await browser.newContext();
  await useSession(memberContext, memberToken);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(browserUrl("/groups"));
  await expect(memberPage.getByText(TEAM_NAME, { exact: true })).toBeVisible();
  await memberPage
    .getByRole("button", { name: "Request to join", exact: true })
    .click();
  await expect(
    memberPage.getByRole("button", { name: "Request to join", exact: true }),
  ).toHaveCount(0);
  await expect.poll(async () => {
    return harness.db.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: memberId } },
      select: { status: true },
    });
  }).toEqual({ status: "PENDING" });

  await administratorPage.goto(browserUrl("/groups"));
  await administratorPage
    .getByRole("button", { name: "Approve request", exact: true })
    .click();
  await expect(
    administratorPage.getByRole("button", {
      name: "Approve request",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect.poll(async () => {
    return harness.db.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: memberId } },
      select: { status: true },
    });
  }).toEqual({ status: "APPROVED" });

  await administratorPage.goto(browserUrl(`/dashboard/${teamId}`));
  await administratorPage.getByLabel("Amount").fill("100.00");
  await administratorPage.getByLabel("Note").fill("Browser initial funding");
  await administratorPage
    .getByRole("button", { name: "Save addition", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect.poll(async () => {
    return harness.db.transaction.count({
      where: { teamId, note: "Browser initial funding" },
    });
  }).toBe(1);

  await administratorPage.getByLabel("Transaction type").click();
  await administratorPage
    .getByRole("option", { name: "Remove money" })
    .click();
  await administratorPage.getByLabel("Amount").fill("25.00");
  await administratorPage.getByLabel("Note").fill("Browser approved expense");
  await administratorPage
    .getByRole("button", { name: "Save removal", exact: true })
    .click();
  await expect.poll(async () => {
    return harness.db.transaction.count({ where: { teamId } });
  }).toBe(2);

  const transactionDate = parseTransactionDateInput(
    getBusinessTodayDateInputValue(),
  );
  await harness.db.transaction.createMany({
    data: Array.from({ length: 26 }, (_, index) => ({
      teamId,
      userId: administratorId,
      idempotencyKey: randomUUID(),
      actorIdSnapshot: administratorId,
      actorNameSnapshot: "Browser Workflow Administrator",
      type: "ADD" as const,
      amountInCents: index + 1,
      note: `Browser pagination ${index + 1}`,
      transactionDate,
    })),
  });
  await administratorPage.reload();
  await expect(administratorPage.getByText("25 loaded", { exact: true })).toBeVisible();
  await administratorPage
    .getByRole("button", { name: "Load more transactions", exact: true })
    .click();
  await expect(administratorPage.getByText("28 loaded", { exact: true })).toBeVisible();

  await administratorPage.goto(browserUrl("/groups"));
  await administratorPage
    .getByRole("button", { name: "Quarantine group", exact: true })
    .click();
  const quarantineDialog = administratorPage.getByRole("dialog");
  await quarantineDialog.getByRole("textbox").fill(TEAM_NAME);
  await quarantineDialog
    .getByRole("button", { name: "Quarantine for 30 days", exact: true })
    .click();
  await expect.poll(async () => {
    return harness.db.team.findUnique({
      where: { id: teamId },
      select: { deletedAt: true },
    });
  }).not.toEqual({ deletedAt: null });

  await administratorPage.goto(browserUrl("/admin"));
  await administratorPage
    .getByLabel(`Type ${TEAM_NAME} to restore`)
    .fill(TEAM_NAME);
  await administratorPage
    .getByRole("button", { name: "Restore team", exact: true })
    .click();
  await expect.poll(async () => {
    return harness.db.team.findUnique({
      where: { id: teamId },
      select: { deletedAt: true },
    });
  }).toEqual({ deletedAt: null });

  const memberCard = administratorPage
    .getByText(MEMBER_EMAIL, { exact: true })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-3xl ')][1]",
    );
  await memberCard
    .getByRole("button", { name: "Disable account", exact: true })
    .click();
  await expect.poll(async () => {
    return harness.db.user.findUnique({
      where: { id: memberId },
      select: { status: true },
    });
  }).toEqual({ status: "DISABLED" });
  await expect(
    memberCard.getByRole("button", {
      name: "Re-enable account",
      exact: true,
    }),
  ).toBeVisible();
  expect(sessionProxy.listening).toBe(true);
  expect((await fetch(browserUrl("/api/health"))).status).toBe(200);

  await memberContext.close();
  const disabledMemberContext = await browser.newContext();
  await useSession(disabledMemberContext, memberToken);
  const disabledAccess = await disabledMemberContext.request.get(
    browserUrl("/groups"),
    { maxRedirects: 0 },
  );
  expect(disabledAccess.status()).toBe(307);
  const disabledRedirectLocation = disabledAccess.headers().location;
  expect(disabledRedirectLocation).toBeTruthy();
  const disabledRedirect = new URL(disabledRedirectLocation!);
  expect(disabledRedirect.pathname).toBe("/login");
  expect(disabledRedirect.searchParams.get("callbackUrl")).toBe(
    new URL("/groups", disabledRedirect.origin).toString(),
  );

  await administratorPage.goto(browserUrl(`/dashboard/${teamId}`));
  await expect(
    administratorPage.getByText("25 loaded", { exact: true }),
  ).toBeVisible();
  await administratorPage
    .getByRole("button", { name: "Load more transactions", exact: true })
    .click();
  await expect(
    administratorPage.getByText("28 loaded", { exact: true }),
  ).toBeVisible();
  await expect(
    administratorPage.getByText("Browser initial funding", { exact: true }),
  ).toBeVisible();
  await expect(
    administratorPage.getByText("Browser approved expense", { exact: true }),
  ).toBeVisible();

  await disabledMemberContext.close();
  await administratorContext.close();
});
