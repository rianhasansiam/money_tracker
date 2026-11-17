import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { RateLimitExceededError, RateLimitUnavailableError } from "@/lib/rate-limit";
import { recordSessionDeadline } from "@/lib/auth-session-lifetime";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), proxy: vi.fn(), enforceStart: vi.fn(),
}));
vi.mock("next-auth", () => ({ default: () => ({
  handlers: { GET: mocks.get, POST: mocks.post }, auth: mocks.proxy,
  signIn: vi.fn(), signOut: vi.fn(),
}) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth-adapter", () => ({ createHardenedPrismaAdapter: vi.fn() }));
vi.mock("@/lib/invitations", () => ({
  createPrismaInvitationRepository: vi.fn(), admitInvitedGoogleIdentity: vi.fn(),
}));
vi.mock("@/lib/authentication-start", () => ({ enforceAuthenticationStart: mocks.enforceStart }));

let authentication: typeof import("@/lib/auth");
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_URL", "http://localhost:3000");
  vi.stubEnv("VERCEL", "");
  authentication = await import("@/lib/auth");
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.enforceStart.mockResolvedValue(undefined);
  mocks.post.mockImplementation(async () => new Response("handled"));
  mocks.get.mockImplementation(async () => new Response("handled"));
});

function request(path: string, method = "POST", host = "localhost:3000") {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers: { host } });
}

describe("public Auth.js handler controls", () => {
  it("charges direct Google starts once and never charges callbacks, CSRF, or GET sign-in pages", async () => {
    expect((await authentication.handlers.POST(request("/api/auth/signin/google"))).status).toBe(200);
    expect(mocks.enforceStart).toHaveBeenCalledTimes(1);
    await authentication.handlers.POST(request("/api/auth/callback/google"));
    await authentication.handlers.GET(request("/api/auth/csrf", "GET"));
    await authentication.handlers.GET(request("/api/auth/signin/google", "GET"));
    expect(mocks.enforceStart).toHaveBeenCalledTimes(1);
  });

  it("keeps host rejection ahead of quota consumption", async () => {
    const response = await authentication.handlers.POST(request("/api/auth/signin/google", "POST", "unexpected.invalid"));
    expect(response.status).toBe(400);
    expect(mocks.enforceStart).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("returns safe retry information and never delegates an over-quota start", async () => {
    mocks.enforceStart.mockRejectedValue(new RateLimitExceededError(42));
    const response = await authentication.handlers.POST(request("/api/auth/signin/google"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("fails closed when either trusted IP resolution or the limiter is unavailable", async () => {
    mocks.enforceStart.mockRejectedValue(new RateLimitUnavailableError());
    const response = await authentication.handlers.POST(request("/api/auth/signin/google"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "unavailable" });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("caps emitted API and Proxy cookies and keeps the public DTO minimized", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const cookie = `authjs.session-token=opaque; Path=/; HttpOnly; Expires=${new Date(Date.now() + 8 * 60 * 60_000).toUTCString()}`;
    mocks.get.mockImplementation(async () => {
      recordSessionDeadline(deadline);
      return Response.json({ expires: deadline.toISOString(), user: { id: "private-id", name: "Fixture", email: null, image: null, role: "ADMIN" } }, { headers: { "set-cookie": cookie } });
    });
    const api = await authentication.handlers.GET(request("/api/auth/session", "GET"));
    expect((await api.json()).user).not.toHaveProperty("id");
    mocks.proxy.mockImplementation(async () => {
      recordSessionDeadline(deadline);
      return new Response(null, { headers: { "set-cookie": cookie, "x-middleware-next": "1" } });
    });
    const proxy = await authentication.proxy(request("/groups", "GET"), {} as NextFetchEvent);
    for (const response of [api, proxy]) {
      expect(Date.parse(/expires=([^;]+)/i.exec(response.headers.get("set-cookie")!)![1])).toBeLessThanOrEqual(deadline.getTime());
    }
    expect(proxy.headers.get("x-middleware-next")).toBe("1");
  });
});
