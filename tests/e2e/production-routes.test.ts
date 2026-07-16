import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken } from "@/lib/auth-adapter";
import {
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
  type PostgresTestHarness,
} from "../helpers/postgres-test-harness";

const configuredBaseUrl = process.env.E2E_BASE_URL?.trim();
const canRun =
  Boolean(configuredBaseUrl) && isPostgresTestDatabaseConfigured();
const describeWithServer = canRun ? describe : describe.skip;

interface SmokeFixture {
  cookies: {
    approvedMember: string;
    crossTeamMember: string;
    disabledUser: string;
    globalAdmin: string;
    globalModerator: string;
    pendingMember: string;
    revokedMember: string;
    teamAdmin: string;
    teamModerator: string;
  };
  disabledSessionDigest: string;
  primaryTeamId: string;
  secondaryTeamId: string;
}

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

  // Auth.js selects the secure prefix from the deployment/request topology.
  // Supplying both test-only cookie names keeps the smoke portable without
  // weakening the production cookie configuration.
  return [
    `authjs.session-token=${encodedToken}`,
    `__Secure-authjs.session-token=${encodedToken}`,
  ].join("; ");
}

async function request(
  baseUrl: string,
  pathname: string,
  options: { cookie?: string } = {},
) {
  return fetch(new URL(pathname, baseUrl), {
    redirect: "manual",
    headers: options.cookie
      ? {
          cookie: options.cookie,
        }
      : undefined,
  });
}

function expectLoginRedirect(response: Response) {
  expect([302, 303, 307, 308]).toContain(response.status);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  expect(new URL(location ?? "/", response.url).pathname).toBe("/login");
}

async function expectAppRedirect(
  response: Response,
  pathname: string,
  scenario = "protected route",
) {
  if ([302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    expect(location, scenario).toBeTruthy();
    expect(new URL(location ?? "/", response.url).pathname, scenario).toBe(
      pathname,
    );
    return;
  }

  // A redirect thrown after an App Router response starts streaming is
  // represented by Next.js as a 200 document with a redirect meta tag.
  expect(response.status, scenario).toBe(200);
  const html = await response.text();
  expect(html, scenario).toContain(`url=${pathname}`);
}

function expectGroupsRedirect(response: Response, scenario?: string) {
  return expectAppRedirect(response, "/groups", scenario);
}

describeWithServer("production route smoke", () => {
  let baseUrl: string;
  let harness: PostgresTestHarness;
  let fixture: SmokeFixture;

  beforeAll(async () => {
    baseUrl = requireBaseUrl();
    harness = await openPostgresTestHarness();
    await harness.clean();

    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1_000);
    const rawTokens = {
      approvedMember: `synthetic-approved-${randomUUID()}`,
      crossTeamMember: `synthetic-cross-team-${randomUUID()}`,
      disabledUser: `synthetic-disabled-${randomUUID()}`,
      globalAdmin: `synthetic-admin-${randomUUID()}`,
      globalModerator: `synthetic-global-moderator-${randomUUID()}`,
      pendingMember: `synthetic-pending-${randomUUID()}`,
      revokedMember: `synthetic-revoked-${randomUUID()}`,
      teamAdmin: `synthetic-team-admin-${randomUUID()}`,
      teamModerator: `synthetic-team-moderator-${randomUUID()}`,
    };
    const admin = await harness.db.user.create({
      data: {
        name: "Route Smoke Admin",
        email: "route-smoke-admin@example.test",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const disabled = await harness.db.user.create({
      data: {
        name: "Disabled Route Smoke User",
        email: "route-smoke-disabled@example.test",
        role: "MEMBER",
        status: "DISABLED",
        disabledAt: now,
        lastAuthenticatedAt: now,
      },
    });
    const globalModerator = await harness.db.user.create({
      data: {
        name: "Route Smoke Global Moderator",
        email: "route-smoke-global-moderator@example.test",
        role: "MODERATOR",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const teamAdmin = await harness.db.user.create({
      data: {
        name: "Route Smoke Team Admin",
        email: "route-smoke-team-admin@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const teamModerator = await harness.db.user.create({
      data: {
        name: "Route Smoke Team Moderator",
        email: "route-smoke-team-moderator@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const approvedMember = await harness.db.user.create({
      data: {
        name: "Route Smoke Approved Member",
        email: "route-smoke-approved@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const pendingMember = await harness.db.user.create({
      data: {
        name: "Route Smoke Pending Member",
        email: "route-smoke-pending@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const revokedMember = await harness.db.user.create({
      data: {
        name: "Route Smoke Revoked Member",
        email: "route-smoke-revoked@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const crossTeamMember = await harness.db.user.create({
      data: {
        name: "Route Smoke Cross-team Member",
        email: "route-smoke-cross-team@example.test",
        role: "MEMBER",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const primaryTeam = await harness.db.team.create({
      data: {
        name: "Production Route Smoke Team",
        description: "Synthetic data used only by the local route smoke.",
        createdById: admin.id,
      },
    });
    const secondaryTeam = await harness.db.team.create({
      data: {
        name: "Production Route Secondary Team",
        description: "Synthetic cross-team authorization fixture.",
        createdById: admin.id,
      },
    });

    await harness.db.teamMembership.createMany({
      data: [
        {
          teamId: primaryTeam.id,
          userId: admin.id,
          role: "ADMIN",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
        {
          teamId: secondaryTeam.id,
          userId: admin.id,
          role: "ADMIN",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
        {
          teamId: primaryTeam.id,
          userId: teamAdmin.id,
          role: "ADMIN",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
        {
          teamId: primaryTeam.id,
          userId: teamModerator.id,
          role: "MODERATOR",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
        {
          teamId: primaryTeam.id,
          userId: approvedMember.id,
          role: "MEMBER",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
        {
          teamId: primaryTeam.id,
          userId: pendingMember.id,
          role: "MEMBER",
          status: "PENDING",
        },
        {
          teamId: primaryTeam.id,
          userId: revokedMember.id,
          role: "MEMBER",
          status: "REVOKED",
        },
        {
          teamId: secondaryTeam.id,
          userId: crossTeamMember.id,
          role: "MEMBER",
          status: "APPROVED",
          approvedAt: now,
          approvedById: admin.id,
        },
      ],
    });
    await harness.db.session.createMany({
      data: [
        [rawTokens.globalAdmin, admin.id],
        [rawTokens.disabledUser, disabled.id],
        [rawTokens.globalModerator, globalModerator.id],
        [rawTokens.teamAdmin, teamAdmin.id],
        [rawTokens.teamModerator, teamModerator.id],
        [rawTokens.approvedMember, approvedMember.id],
        [rawTokens.pendingMember, pendingMember.id],
        [rawTokens.revokedMember, revokedMember.id],
        [rawTokens.crossTeamMember, crossTeamMember.id],
      ].map(([rawToken, userId]) => ({
        sessionToken: hashSessionToken(rawToken),
        userId,
        expires,
        createdAt: now,
      })),
    });

    fixture = {
      cookies: {
        approvedMember: sessionCookie(rawTokens.approvedMember),
        crossTeamMember: sessionCookie(rawTokens.crossTeamMember),
        disabledUser: sessionCookie(rawTokens.disabledUser),
        globalAdmin: sessionCookie(rawTokens.globalAdmin),
        globalModerator: sessionCookie(rawTokens.globalModerator),
        pendingMember: sessionCookie(rawTokens.pendingMember),
        revokedMember: sessionCookie(rawTokens.revokedMember),
        teamAdmin: sessionCookie(rawTokens.teamAdmin),
        teamModerator: sessionCookie(rawTokens.teamModerator),
      },
      disabledSessionDigest: hashSessionToken(rawTokens.disabledUser),
      primaryTeamId: primaryTeam.id,
      secondaryTeamId: secondaryTeam.id,
    };
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("serves public routes and rejects every protected route without a session", async () => {
    const [home, login, groups, dashboardIndex, dashboard, admin] = await Promise.all([
      request(baseUrl, "/"),
      request(baseUrl, "/login"),
      request(baseUrl, "/groups"),
      request(baseUrl, "/dashboard"),
      request(baseUrl, `/dashboard/${fixture.primaryTeamId}`),
      request(baseUrl, "/admin"),
    ]);

    expect(home.status).toBe(200);
    expect(login.status).toBe(200);
    expectLoginRedirect(groups);
    expectLoginRedirect(dashboardIndex);
    expectLoginRedirect(dashboard);
    expectLoginRedirect(admin);
  });

  it("renders authorized groups, dashboard, and administration pages", async () => {
    const [groups, dashboard, admin] = await Promise.all([
      request(baseUrl, "/groups", { cookie: fixture.cookies.globalAdmin }),
      request(baseUrl, `/dashboard/${fixture.primaryTeamId}`, {
        cookie: fixture.cookies.globalAdmin,
      }),
      request(baseUrl, "/admin", { cookie: fixture.cookies.globalAdmin }),
    ]);
    const [groupsHtml, dashboardHtml, adminHtml] = await Promise.all([
      groups.text(),
      dashboard.text(),
      admin.text(),
    ]);

    expect(groups.status).toBe(200);
    expect(groupsHtml).toContain("Production Route Smoke Team");
    expect(dashboard.status).toBe(200);
    expect(dashboardHtml).toContain("Production Route Smoke Team");
    expect(admin.status).toBe(200);
    expect(adminHtml).toContain("Security and lifecycle console");
  });

  it("enforces the authenticated page and role matrix without cross-team leakage", async () => {
    for (const cookie of [
      fixture.cookies.approvedMember,
      fixture.cookies.crossTeamMember,
      fixture.cookies.globalAdmin,
      fixture.cookies.globalModerator,
      fixture.cookies.pendingMember,
      fixture.cookies.revokedMember,
      fixture.cookies.teamAdmin,
      fixture.cookies.teamModerator,
    ]) {
      const response = await request(baseUrl, "/groups", { cookie });
      expect(response.status).toBe(200);
    }

    const globalAdminDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.globalAdmin },
    );
    const teamAdminDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.teamAdmin },
    );
    const moderatorDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.teamModerator },
    );
    const memberDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.approvedMember },
    );
    const pendingDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.pendingMember },
    );
    const revokedDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.revokedMember },
    );
    const crossTeamDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.crossTeamMember },
    );
    const globalModeratorDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.primaryTeamId}`,
      { cookie: fixture.cookies.globalModerator },
    );
    const crossTeamOwnDashboard = await request(
      baseUrl,
      `/dashboard/${fixture.secondaryTeamId}`,
      { cookie: fixture.cookies.crossTeamMember },
    );

    for (const response of [
      globalAdminDashboard,
      teamAdminDashboard,
      moderatorDashboard,
      memberDashboard,
      crossTeamOwnDashboard,
    ]) {
      expect(response.status).toBe(200);
    }

    for (const [scenario, response] of [
      ["pending membership", pendingDashboard],
      ["revoked membership", revokedDashboard],
      ["cross-team identifier", crossTeamDashboard],
      ["global moderator without membership", globalModeratorDashboard],
    ] as const) {
      await expectGroupsRedirect(response, scenario);
    }

    for (const [scenario, cookie, expectedPath] of [
      [
        "approved member dashboard index",
        fixture.cookies.approvedMember,
        `/dashboard/${fixture.primaryTeamId}`,
      ],
      [
        "team administrator dashboard index",
        fixture.cookies.teamAdmin,
        `/dashboard/${fixture.primaryTeamId}`,
      ],
      [
        "team moderator dashboard index",
        fixture.cookies.teamModerator,
        `/dashboard/${fixture.primaryTeamId}`,
      ],
      [
        "cross-team member dashboard index",
        fixture.cookies.crossTeamMember,
        `/dashboard/${fixture.secondaryTeamId}`,
      ],
      ["pending member dashboard index", fixture.cookies.pendingMember, "/groups"],
      ["revoked member dashboard index", fixture.cookies.revokedMember, "/groups"],
      [
        "global moderator dashboard index",
        fixture.cookies.globalModerator,
        "/groups",
      ],
    ] as const) {
      await expectAppRedirect(
        await request(baseUrl, "/dashboard", { cookie }),
        expectedPath,
        scenario,
      );
    }

    const [teamAdminHtml, moderatorHtml, memberHtml] = await Promise.all([
      teamAdminDashboard.text(),
      moderatorDashboard.text(),
      memberDashboard.text(),
    ]);

    expect(teamAdminHtml).toContain("Create transaction");
    expect(moderatorHtml).toContain("Create transaction");
    expect(memberHtml).not.toContain("Create transaction");
    expect(memberHtml).toContain("View-only access");

    const nonGlobalAdminCookies = [
      fixture.cookies.approvedMember,
      fixture.cookies.crossTeamMember,
      fixture.cookies.globalModerator,
      fixture.cookies.pendingMember,
      fixture.cookies.revokedMember,
      fixture.cookies.teamAdmin,
      fixture.cookies.teamModerator,
    ];

    for (const [index, cookie] of nonGlobalAdminCookies.entries()) {
      const response = await request(baseUrl, "/admin", { cookie });
      await expectGroupsRedirect(
        response,
        `non-global administrator ${index + 1}`,
      );
    }
  });

  it("does not expose the internal user ID from the public session endpoint", async () => {
    const response = await request(baseUrl, "/api/auth/session", {
      cookie: fixture.cookies.globalAdmin,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty("user");
    expect(serialized).not.toContain("route-smoke-admin@example.test");
    expect(serialized).not.toContain("sessionToken");
    expect((payload.user as Record<string, unknown>)).not.toHaveProperty("id");
  });

  it("rejects a disabled user on the next protected request and revokes the session", async () => {
    const response = await request(baseUrl, "/groups", {
      cookie: fixture.cookies.disabledUser,
    });

    expectLoginRedirect(response);
    await expect(
      harness.db.session.count({
        where: {
          sessionToken: fixture.disabledSessionDigest,
        },
      }),
    ).resolves.toBe(0);
  });

  it("returns hardened headers and minimal health information", async () => {
    const [login, protectedPage, health, ready] = await Promise.all([
      request(baseUrl, "/login"),
      request(baseUrl, "/groups", { cookie: fixture.cookies.globalAdmin }),
      request(baseUrl, "/api/health"),
      request(baseUrl, "/api/ready"),
    ]);

    for (const response of [login, protectedPage, health]) {
      expect(response.headers.get("content-security-policy-report-only")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("x-powered-by")).toBeNull();
    }

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });
});
