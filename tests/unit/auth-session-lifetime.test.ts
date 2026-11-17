import { afterEach, describe, expect, it, vi } from "vitest";
import { recordSessionDeadline, withSessionCookieDeadline } from "@/lib/auth-session-lifetime";

afterEach(() => vi.useRealTimers());

describe("outgoing Auth.js session cookie deadline", () => {
  it("caps Expires and Max-Age while preserving non-session and cleared cookies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-16T07:59:00.000Z");
    const deadline = new Date("2026-11-16T08:00:00.000Z");
    const response = await withSessionCookieDeadline(async () => {
      recordSessionDeadline(deadline);
      const headers = new Headers();
      headers.append("set-cookie", "__Secure-authjs.session-token=opaque; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800; Expires=Tue, 17 Nov 2026 00:00:00 GMT");
      headers.append("set-cookie", "authjs.csrf-token=unchanged; Path=/; HttpOnly");
      headers.append("set-cookie", "authjs.session-token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      return new Response("payload", { headers });
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain("Expires=Mon, 16 Nov 2026 08:00:00 GMT");
    expect(cookies[0]).toContain("Max-Age=60");
    expect(cookies[0]).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookies[1]).toBe("authjs.csrf-token=unchanged; Path=/; HttpOnly");
    expect(cookies[2]).toContain("Max-Age=0");
    expect(cookies[2]).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(await response.text()).toBe("payload");
  });

  it("isolates concurrent requests and carries no deadline into a later response", async () => {
    const responses = await Promise.all(["2026-11-16T08:00:00Z", "2026-11-16T12:00:00Z"].map((date) => withSessionCookieDeadline(async () => {
      recordSessionDeadline(new Date(date));
      await Promise.resolve();
      return new Response(null, { headers: { "set-cookie": "authjs.session-token=opaque; Path=/" } });
    })));
    expect(responses[0].headers.get("set-cookie")).toContain("08:00:00 GMT");
    expect(responses[1].headers.get("set-cookie")).toContain("12:00:00 GMT");
    const unscoped = await withSessionCookieDeadline(async () => new Response(null, { headers: { "set-cookie": "authjs.session-token=opaque; Path=/" } }));
    expect(unscoped.headers.get("set-cookie")).not.toContain("Expires");
  });
});
