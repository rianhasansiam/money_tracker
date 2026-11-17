import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_HEADER, startBrowserSessionProxy } from "../helpers/browser-session-proxy";

describe("canonical browser session proxy", () => {
  it("forwards the canonical origin, preserves foreign CSRF origins, and maps local redirects", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://${request.headers.host}/groups` });
        response.end();
      } else if (request.url?.startsWith("/action-redirect")) {
        const port = new URL(`http://${request.headers.host}`).port;
        const destination = request.url.includes("foreign") ? "https://foreign.invalid/" : request.url.includes("wrong-port") ? `http://localhost:${Number(port) + 1}/` : `http://localhost:${port}/`;
        response.writeHead(200, { "x-action-redirect": `${destination};push` });
        response.end("Server Action redirect");
      } else if (request.url?.startsWith("/next-redirect")) {
        // Match Auth.js handleAuth: clone NextRequest.nextUrl, change pathname,
        // and attach the original nextUrl.href as the callback URL.
        const url = new NextRequest(`http://${request.headers.host}/groups?view=all#history`).nextUrl;
        const redirect = url.clone();
        redirect.pathname = "/login";
        redirect.searchParams.set("callbackUrl", request.url.includes("foreign")
          ? "https://foreign.invalid/groups" : url.href);
        response.writeHead(307, { location: redirect.toString() });
        response.end();
      } else if (request.url?.startsWith("/foreign-redirect")) {
        const port = new URL(`http://${request.headers.host}`).port;
        const location = request.url.includes("wrong-port")
          ? `http://localhost:${Number(port) + 1}/login?callbackUrl=http%3A%2F%2Flocalhost%3A${port}%2Fgroups`
          : `https://foreign.invalid/login?callbackUrl=http%3A%2F%2Flocalhost%3A${port}%2Fgroups`;
        response.writeHead(307, { location });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.headers));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address.");
    const canonicalOrigin = `http://127.0.0.1:${address.port}`;
    const proxy = await startBrowserSessionProxy(canonicalOrigin);
    try {
      const response = await fetch(proxy.origin, { headers: {
        origin: proxy.origin,
        referer: `${proxy.origin}/login?from=test`,
        "x-forwarded-host": "untrusted.invalid",
        "x-forwarded-for": "203.0.113.250",
        [SESSION_HEADER]: "synthetic-session",
      } });
      const headers = await response.json();
      expect(headers.host).toBe(new URL(canonicalOrigin).host);
      expect(headers["x-forwarded-host"]).toBe(new URL(canonicalOrigin).host);
      expect(headers["x-forwarded-proto"]).toBe("http");
      expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
      expect(headers.origin).toBe(canonicalOrigin);
      expect(headers.referer).toBe(`${canonicalOrigin}/login?from=test`);
      expect(headers.cookie).toContain("authjs.session-token=synthetic-session");
      expect(headers[SESSION_HEADER]).toBeUndefined();

      const foreign = await fetch(proxy.origin, { headers: {
        origin: "https://foreign.invalid",
        referer: "https://foreign.invalid/path",
      } });
      expect(await foreign.json()).toMatchObject({
        origin: "https://foreign.invalid", referer: "https://foreign.invalid/path",
      });
      const redirect = await fetch(`${proxy.origin}/redirect`, { redirect: "manual" });
      expect(redirect.headers.get("location")).toBe(`${proxy.origin}/groups`);

      const actionRedirect = await fetch(`${proxy.origin}/action-redirect`);
      expect(actionRedirect.headers.get("x-action-redirect")).toBe(`${proxy.origin}/;push`);
      for (const path of ["/action-redirect-foreign", "/action-redirect-wrong-port"]) {
        const response = await fetch(`${proxy.origin}${path}`);
        const target = response.headers.get("x-action-redirect")!;
        expect(target.startsWith(proxy.origin)).toBe(false);
        expect(target).toBe(path.includes("foreign") ? "https://foreign.invalid/;push" : `http://localhost:${address.port + 1}/;push`);
      }

      const nextRedirect = await fetch(`${proxy.origin}/next-redirect`, { redirect: "manual" });
      const mapped = new URL(nextRedirect.headers.get("location")!);
      expect(mapped.origin).toBe(proxy.origin);
      expect(mapped.pathname).toBe("/login");
      expect(mapped.searchParams.get("callbackUrl")).toBe(`${canonicalOrigin}/groups?view=all#history`);

      const foreignCallback = await fetch(`${proxy.origin}/next-redirect-foreign`, { redirect: "manual" });
      expect(new URL(foreignCallback.headers.get("location")!).searchParams.get("callbackUrl")).toBe("https://foreign.invalid/groups");
      for (const path of ["/foreign-redirect", "/foreign-redirect-wrong-port"]) {
        const foreignRedirect = await fetch(`${proxy.origin}${path}`, { redirect: "manual" });
        const location = new URL(foreignRedirect.headers.get("location")!);
        expect(location.origin).not.toBe(proxy.origin);
        expect(location.searchParams.get("callbackUrl")).toBe(`http://localhost:${address.port}/groups`);
      }
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => error ? reject(error) : resolve());
        upstream.closeIdleConnections();
      });
    }
  });

  it("rejects non-loopback upstream configuration", async () => {
    await expect(startBrowserSessionProxy("http://example.test")).rejects.toThrow("loopback HTTP");
  });

  it("maps only the configured managed HTTPS application origin, preserving foreign hosts and ports", async () => {
    const canonical = "https://managed.example.test";
    const upstream = createServer((request, response) => {
      const destination = request.url === "/foreign" ? "https://foreign.invalid/login"
        : request.url === "/other-port" ? "https://managed.example.test:8443/login"
          : `${canonical}/login?reauth=1&callbackUrl=${encodeURIComponent(`${canonical}/admin`)}`;
      response.writeHead(200, { "x-action-redirect": `${destination};replace`, location: destination });
      response.end("Action redirect");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address.");
    const proxy = await startBrowserSessionProxy(`http://127.0.0.1:${address.port}`, { canonicalOrigin: canonical });
    try {
      const response = await fetch(proxy.origin);
      const target = new URL(response.headers.get("location")!);
      expect(target.origin).toBe(proxy.origin);
      expect(target.searchParams.get("callbackUrl")).toBe(`${canonical}/admin`);
      expect(response.headers.get("x-action-redirect")).toBe(`${target};replace`);
      for (const path of ["/foreign", "/other-port"]) {
        const response = await fetch(`${proxy.origin}${path}`);
        const expected = path === "/foreign" ? "https://foreign.invalid/login" : "https://managed.example.test:8443/login";
        expect(response.headers.get("location")).toBe(expected);
        expect(response.headers.get("x-action-redirect")).toBe(`${expected};replace`);
      }
      await expect(startBrowserSessionProxy(`http://127.0.0.1:${address.port}`, { canonicalOrigin: "http://foreign.invalid" })).rejects.toThrow("HTTPS origin");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => error ? reject(error) : resolve());
        upstream.closeIdleConnections();
      });
    }
  });
});
