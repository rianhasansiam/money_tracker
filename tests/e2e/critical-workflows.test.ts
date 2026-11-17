import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@/lib/auth-adapter";
import {
  getBusinessTodayDateInputValue,
  parseTransactionDateInput,
} from "@/lib/date-time";
import {
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
  type PostgresTestHarness,
} from "../helpers/postgres-test-harness";

const configuredBaseUrl = process.env.E2E_BASE_URL?.trim();
const canRun =
  Boolean(configuredBaseUrl) && isPostgresTestDatabaseConfigured();
const describeWithServer = canRun ? describe : describe.skip;

interface MockSession {
  user: {
    id: string;
    role: "ADMIN" | "MODERATOR" | "MEMBER";
  };
}

const actionMocks = vi.hoisted(() => ({
  auth: vi.fn<() => Promise<MockSession | null>>(),
  refresh: vi.fn<() => void>(),
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("@/lib/auth", () => ({
  auth: actionMocks.auth,
}));

vi.mock("next/cache", () => ({
  refresh: actionMocks.refresh,
  revalidatePath: actionMocks.revalidatePath,
}));

type AdminActionModule = typeof import("@/actions/admin");
type AdminBootstrapModule = typeof import("@/lib/admin-bootstrap");
type DashboardActionModule = typeof import("@/actions/dashboard");
type DashboardQueryModule = typeof import("@/lib/queries/dashboard");
type GroupActionModule = typeof import("@/actions/groups");
type InvitationModule = typeof import("@/lib/invitations");
type TransactionActionModule = typeof import("@/actions/transactions");

function requireBaseUrl() {
  if (!configuredBaseUrl) {
    throw new Error(
      "E2E_BASE_URL must identify the separately started local production server.",
    );
  }

  const parsed = new URL(configuredBaseUrl);

  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("E2E_BASE_URL must be an origin on the local machine.");
  }

  return parsed.origin;
}

function sessionCookie(rawToken: string) {
  const encodedToken = encodeURIComponent(rawToken);

  return [
    `authjs.session-token=${encodedToken}`,
    `__Secure-authjs.session-token=${encodedToken}`,
  ].join("; ");
}

async function request(baseUrl: string, pathname: string, cookie?: string) {
  return fetch(new URL(pathname, baseUrl), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
}

async function expectRedirect(response: Response, pathname: string) {
  if ([302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location ?? "/", response.url).pathname).toBe(pathname);
    return;
  }

  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`url=${pathname}`);
}

describeWithServer("critical production workflow", () => {
  let adminActions: AdminActionModule;
  let adminBootstrap: AdminBootstrapModule;
  let baseUrl: string;
  let dashboardActions: DashboardActionModule;
  let dashboardQueries: DashboardQueryModule;
  let groupActions: GroupActionModule;
  let harness: PostgresTestHarness;
  let invitations: InvitationModule;
  let previousRateLimitHashSecret: string | undefined;
  let transactionActions: TransactionActionModule;

  beforeAll(async () => {
    baseUrl = requireBaseUrl();
    previousRateLimitHashSecret = process.env.RATE_LIMIT_HASH_SECRET;
    process.env.RATE_LIMIT_HASH_SECRET =
      "disposable-e2e-rate-limit-hash-secret";
    harness = await openPostgresTestHarness();
    await harness.clean();

    [
      adminActions,
      adminBootstrap,
      dashboardActions,
      dashboardQueries,
      groupActions,
      invitations,
      transactionActions,
    ] = await Promise.all([
      import("@/actions/admin"),
      import("@/lib/admin-bootstrap"),
      import("@/actions/dashboard"),
      import("@/lib/queries/dashboard"),
      import("@/actions/groups"),
      import("@/lib/invitations"),
      import("@/actions/transactions"),
    ]);
  }, 30_000);

  afterAll(async () => {
    try {
      await harness?.close();
    } finally {
      if (previousRateLimitHashSecret === undefined) {
        delete process.env.RATE_LIMIT_HASH_SECRET;
      } else {
        process.env.RATE_LIMIT_HASH_SECRET = previousRateLimitHashSecret;
      }
    }
  }, 30_000);

  function authenticateAs(
    userId: string,
    role: "ADMIN" | "MODERATOR" | "MEMBER",
  ) {
    actionMocks.auth.mockResolvedValue({ user: { id: userId, role } });
  }

  it("executes bootstrap, admission, team, ledger, retention, and offboarding end to end", async () => {
    const now = new Date();
    const administratorEmail = "workflow-admin@example.test";
    const memberEmail = "workflow-member@example.test";
    const bootstrapRepository =
      adminBootstrap.createPrismaAdminBootstrapRepository(harness.db);

    await expect(
      adminBootstrap.bootstrapAdmin(bootstrapRepository, administratorEmail),
    ).resolves.toEqual({ status: "created" });

    const administrator = await harness.db.user.update({
      where: { email: administratorEmail },
      data: {
        name: "Workflow Administrator",
        lastAuthenticatedAt: now,
      },
    });

    await expect(
      adminBootstrap.bootstrapAdmin(bootstrapRepository, administratorEmail),
    ).resolves.toEqual({ status: "unchanged" });

    const invitationRepository =
      invitations.createPrismaInvitationRepository(harness.db);

    await expect(
      invitations.admitInvitedGoogleIdentity(
        invitationRepository,
        "not-allowlisted@example.test",
        now,
      ),
    ).resolves.toBe(false);

    await invitations.provisionInvitation(invitationRepository, {
      actorUserId: administrator.id,
      email: memberEmail,
      now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    });
    await expect(
      invitations.admitInvitedGoogleIdentity(
        invitationRepository,
        memberEmail,
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toBe(true);

    const member = await harness.db.user.update({
      where: { email: memberEmail },
      data: {
        name: "Workflow Member",
        lastAuthenticatedAt: now,
      },
    });
    const expires = new Date(now.getTime() + 60 * 60 * 1_000);
    const administratorToken = `workflow-admin-${randomUUID()}`;
    const memberToken = `workflow-member-${randomUUID()}`;

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

    authenticateAs(administrator.id, "ADMIN");
    const createResult = await groupActions.createTeam({
      name: "Critical Workflow Treasury",
      description: "Disposable end-to-end workflow fixture",
    });
    expect(createResult).toMatchObject({ status: "success" });
    if (createResult.status !== "success") {
      throw new Error("The team creation workflow was rejected.");
    }
    const teamId = createResult.teamId;
    expect(teamId).toBeTruthy();
    if (!teamId) {
      throw new Error("The team creation workflow did not return a team ID.");
    }

    authenticateAs(member.id, "MEMBER");
    await expect(groupActions.requestTeamAccess(teamId)).resolves.toMatchObject({
      status: "success",
    });
    const pendingMembership = await harness.db.teamMembership.findUniqueOrThrow({
      where: {
        teamId_userId: {
          teamId,
          userId: member.id,
        },
      },
    });
    expect(pendingMembership.status).toBe("PENDING");

    authenticateAs(administrator.id, "ADMIN");
    await expect(
      groupActions.approveTeamAccess(pendingMembership.id),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      harness.db.teamMembership.findUniqueOrThrow({
        where: { id: pendingMembership.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "APPROVED" });

    const transactionDate = getBusinessTodayDateInputValue(now);
    const addOperationKey = randomUUID();
    const addInput = {
      amount: "100.00",
      note: "Initial funding",
      transactionDate,
      type: "ADD" as const,
    };
    const added = await transactionActions.createTransaction(
      teamId,
      addOperationKey,
      addInput,
    );
    const replayed = await transactionActions.createTransaction(
      teamId,
      addOperationKey,
      addInput,
    );
    const removed = await transactionActions.createTransaction(
      teamId,
      randomUUID(),
      {
        amount: "25.00",
        note: "Approved expense",
        transactionDate,
        type: "REMOVE",
      },
    );

    expect(added).toMatchObject({ status: "success", replayed: false });
    if (added.status !== "success") {
      throw new Error("The initial ledger addition was not committed.");
    }
    expect(replayed).toMatchObject({
      status: "success",
      replayed: true,
      transactionId: added.transactionId,
    });
    expect(removed).toMatchObject({ status: "success", replayed: false });
    await expect(
      harness.db.transaction.count({ where: { teamId } }),
    ).resolves.toBe(2);

    await harness.db.transaction.createMany({
      data: Array.from({ length: 26 }, (_, index) => ({
        teamId,
        userId: administrator.id,
        idempotencyKey: randomUUID(),
        actorIdSnapshot: administrator.id,
        actorNameSnapshot: administrator.name ?? "Workflow Administrator",
        type: "ADD" as const,
        amountInCents: index + 1,
        note: `Pagination fixture ${index + 1}`,
        transactionDate: parseTransactionDateInput(transactionDate),
      })),
    });

    const dashboard = await dashboardQueries.getDashboardData(
      administrator.id,
      teamId,
    );
    expect(dashboard?.balanceInCents).toBe(7_851);
    expect(dashboard?.transactionHistory.transactions).toHaveLength(25);
    expect(dashboard?.transactionHistory.nextCursor).toBeTruthy();

    const nextPage = await dashboardActions.loadMoreTransactionHistory(
      teamId,
      dashboard?.transactionHistory.nextCursor ?? "",
      dashboard?.snapshotRevision ?? "",
    );
    expect(nextPage).toMatchObject({ status: "success" });
    if (nextPage.status !== "success") {
      throw new Error("The authorized pagination workflow did not return a page.");
    }
    expect(nextPage.page.transactions).toHaveLength(3);
    expect(nextPage.page.nextCursor).toBeNull();

    const administratorCookie = sessionCookie(administratorToken);
    const memberCookie = sessionCookie(memberToken);
    const renderedDashboard = await request(
      baseUrl,
      `/dashboard/${teamId}`,
      memberCookie,
    );
    expect(renderedDashboard.status).toBe(200);
    expect(await renderedDashboard.text()).toContain("Critical Workflow Treasury");

    const quarantined = await groupActions.quarantineTeamAction(
      teamId,
      "Critical Workflow Treasury",
    );
    expect(quarantined).toMatchObject({ status: "success" });
    await expectRedirect(
      await request(baseUrl, `/dashboard/${teamId}`, administratorCookie),
      "/groups",
    );

    const restored = await adminActions.restoreTeamAction(
      teamId,
      "Critical Workflow Treasury",
    );
    expect(restored).toMatchObject({ status: "success" });
    expect(
      (
        await request(baseUrl, `/dashboard/${teamId}`, administratorCookie)
      ).status,
    ).toBe(200);

    const disabled = await adminActions.disableUserAction(memberEmail);
    expect(disabled).toMatchObject({ status: "success" });
    await expectRedirect(
      await request(baseUrl, "/groups", memberCookie),
      "/login",
    );
    await expect(
      harness.db.session.count({ where: { userId: member.id } }),
    ).resolves.toBe(0);

    const genericAdmissionFailure = await request(baseUrl, "/auth-error");
    expect(genericAdmissionFailure.status).toBe(200);
    const admissionFailureHtml = await genericAdmissionFailure.text();
    expect(admissionFailureHtml).toContain("Sign-in could not be completed");
    expect(admissionFailureHtml).not.toContain("not-allowlisted@example.test");
  }, 60_000);
});
