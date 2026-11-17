import { randomUUID } from "node:crypto";
import { request as requestHttp } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashSessionToken } from "@/lib/auth-adapter";
import {
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
  type PostgresTestHarness,
} from "../helpers/postgres-test-harness";

const configuredBaseUrl = process.env.E2E_BASE_URL?.trim();
const describeWithServer = configuredBaseUrl && isPostgresTestDatabaseConfigured() ? describe : describe.skip;
const EIGHT_HOURS = 8 * 60 * 60 * 1_000;

function sessionCookie(token: string) {
  return `authjs.session-token=${encodeURIComponent(token)}; __Secure-authjs.session-token=${encodeURIComponent(token)}`;
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => /^(?:__Secure-)?authjs\.session-token=/.test(cookie));
}

function assertCappedCookie(response: Response, deadline: Date) {
  const cookies = sessionCookies(response);
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    const expires = /;\s*expires=([^;]+)/i.exec(cookie)?.[1];
    expect(expires).toBeTruthy();
    expect(Date.parse(expires!)).toBe(Math.floor(deadline.getTime() / 1_000) * 1_000);
    expect(Date.parse(expires!)).toBeGreaterThan(Date.now() - 2_000);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  }
}

describeWithServer("production authentication controls", () => {
  let harness: PostgresTestHarness;
  let userId: string;
  let baseUrl: URL;

  beforeAll(async () => {
    baseUrl = new URL(configuredBaseUrl!);
    if (baseUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
      throw new Error("Authentication HTTP tests require the local test server.");
    }
    harness = await openPostgresTestHarness();
    await harness.clean();
    const user = await harness.db.user.create({ data: {
      email: "session-deadline@example.test", name: "Session Deadline Fixture",
      status: "ACTIVE", role: "ADMIN", lastAuthenticatedAt: new Date(),
    } });
    userId = user.id;
  });
  afterAll(async () => harness?.close());

  async function addSession(createdAt: Date, expires = new Date(Date.now() + EIGHT_HOURS)) {
    const token = `deadline-${randomUUID()}`;
    await harness.db.session.create({ data: {
      userId, sessionToken: hashSessionToken(token), createdAt,
      expires,
    } });
    return token;
  }

  it("caps stored, public, and actual API/Proxy cookie expiry across repeated renewals", async () => {
    const createdAt = new Date(Date.now() - EIGHT_HOURS + 60_000);
    const deadline = new Date(createdAt.getTime() + EIGHT_HOURS);
    const token = await addSession(createdAt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie(token) } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user).toHaveProperty("role", "ADMIN");
      expect(body.user).not.toHaveProperty("id");
      expect(new Date(body.expires).getTime()).toBe(deadline.getTime());
      assertCappedCookie(response, deadline);
      const stored = await harness.db.session.findUniqueOrThrow({ where: { sessionToken: hashSessionToken(token) } });
      expect(stored.createdAt).toEqual(createdAt);
      expect(stored.expires).toEqual(deadline);
    }
    const protectedResponse = await fetch(new URL("/groups", baseUrl), {
      headers: { cookie: sessionCookie(token) }, redirect: "manual",
    });
    expect(protectedResponse.status).toBe(200);
    assertCappedCookie(protectedResponse, deadline);
    await protectedResponse.text();
  });

  it("aligns a still-valid shorter legacy expiry across storage, DTO, and cookie without reviving expired rows", async () => {
    const createdAt = new Date(Date.now() - EIGHT_HOURS + 60_000);
    const deadline = new Date(createdAt.getTime() + EIGHT_HOURS);
    const token = await addSession(createdAt, new Date(Date.now() + 30_000));
    const response = await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie(token) } });
    expect(response.status).toBe(200);
    expect(new Date((await response.json()).expires)).toEqual(deadline);
    assertCappedCookie(response, deadline);
    expect((await harness.db.session.findUniqueOrThrow({ where: { sessionToken: hashSessionToken(token) } })).expires).toEqual(deadline);
    const expiredToken = await addSession(createdAt, new Date(Date.now() - 1));
    const expired = await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie(expiredToken) } });
    expect(await expired.json()).toBeNull();
    expect(await harness.db.session.count({ where: { sessionToken: hashSessionToken(expiredToken) } })).toBe(0);
  });

  it.each([EIGHT_HOURS, EIGHT_HOURS + 1, 9 * 60 * 60 * 1_000])(
    "rejects and clears a session of age %i with future rolling expiry",
    async (age) => {
      const token = await addSession(new Date(Date.now() - age));
      const response = await fetch(new URL("/api/auth/session", baseUrl), { headers: { cookie: sessionCookie(token) } });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      expect(sessionCookies(response).some((cookie) => /max-age=0/i.test(cookie))).toBe(true);
      expect(await harness.db.session.count({ where: { sessionToken: hashSessionToken(token) } })).toBe(0);
      const protectedResponse = await fetch(new URL("/groups", baseUrl), {
        headers: { cookie: sessionCookie(token) }, redirect: "manual",
      });
      expect(protectedResponse.status).toBe(307);
      expect(new URL(protectedResponse.headers.get("location")!, baseUrl).pathname).toBe("/login");
    },
  );

  it("denies direct OAuth start 21 with valid CSRF and one shared durable quota", async () => {
    // Keep the fixed-window regression away from its legitimate reset boundary.
    const untilNextWindow = 300_000 - (Date.now() % 300_000);
    if (untilNextWindow < 30_000) await new Promise((resolve) => setTimeout(resolve, untilNextWindow + 10));
    await harness.db.rateLimitBucket.deleteMany({ where: { scope: "authentication-start" } });
    const csrfResponse = await fetch(new URL("/api/auth/csrf", baseUrl));
    expect(csrfResponse.status).toBe(200);
    const { csrfToken } = await csrfResponse.json();
    const cookie = csrfResponse.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    for (let attempt = 1; attempt <= 21; attempt += 1) {
      const response = await fetch(new URL("/api/auth/signin/google", baseUrl), {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "127.0.0.1" },
        body: new URLSearchParams({ csrfToken, callbackUrl: new URL("/groups", baseUrl).toString() }),
      });
      if (attempt <= 20) {
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get("location")!).hostname).toBe("accounts.google.com");
      } else {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("location")).toBeNull();
        expect(await response.json()).toMatchObject({ error: "rate_limited" });
      }
    }
    const buckets = await harness.db.rateLimitBucket.findMany({ where: { scope: "authentication-start" }, select: { count: true } });
    expect(buckets).toEqual([{ count: 21 }]);
  }, 60_000);

  it("retains real canonical-host rejection and explicit managed-host behavior", async () => {
    // Node fetch normalizes its Host header. Use the HTTP transport to send an
    // actual unexpected authority rather than merely constructing that option.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = requestHttp(new URL("/api/auth/session", baseUrl), {
        headers: { host: "unexpected-request-host.invalid" },
      }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { body += chunk; });
        incoming.on("end", () => resolve({ status: incoming.statusCode!, body }));
        incoming.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    if (process.env.VERCEL === "1") {
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toBeNull();
    } else {
      expect(response.status).toBe(400);
      expect(response.body).toBe("Invalid authentication request.");
    }
  });
});
