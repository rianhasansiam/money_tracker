import { createServer, request as requestUpstream } from "node:http";

export const SESSION_HEADER = "x-money-tracker-test-session";

/** Test-only loopback transport; never imported by the application. */
export async function startBrowserSessionProxy(configuredUpstream: URL | string, options: { canonicalOrigin?: string } = {}) {
  const upstream = new URL(configuredUpstream);
  if (
    upstream.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
    upstream.username || upstream.password || upstream.pathname !== "/" ||
    upstream.search || upstream.hash
  ) {
    throw new Error("The browser test upstream must be a loopback HTTP origin.");
  }
  // CI runs an HTTP upstream behind a synthetic HTTPS application identity.
  // Map only that explicitly configured authority, never arbitrary responses.
  const canonicalValue = options.canonicalOrigin ?? (process.env.VERCEL === "1" ? process.env.AUTH_URL : undefined);
  const canonical = canonicalValue ? new URL(canonicalValue) : null;
  if (canonical && (canonical.protocol !== "https:" || canonical.username || canonical.password || canonical.pathname !== "/" || canonical.search || canonical.hash)) {
    throw new Error("The managed browser test canonical URL must be an HTTPS origin.");
  }

  // NextURL normalizes 127.* and [::1] to localhost. Accept only that known
  // representation of this configured upstream, with the same protocol/port.
  // An unrelated origin (including another loopback port) must stay untouched.
  const normalizedUpstream = new URL(upstream);
  normalizedUpstream.hostname = "localhost";
  function isUpstreamOrigin(url: URL) {
    return url.username === "" && url.password === "" && (
      url.origin === upstream.origin || url.origin === normalizedUpstream.origin
    );
  }

  function mapRedirect(value: string) {
    try {
      const location = new URL(value, upstream);
      const configuredApplication = canonical && location.username === "" && location.password === "" && location.origin === canonical.origin;
      if (!isUpstreamOrigin(location) && !configuredApplication) return value;
      const callback = location.searchParams.get("callbackUrl");
      if (callback) {
        try {
          const callbackUrl = new URL(callback, upstream);
          if (isUpstreamOrigin(callbackUrl)) location.searchParams.set("callbackUrl", new URL(`${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`, upstream).toString());
        } catch {
          // Invalid or foreign callbacks stay unchanged for host/CSRF checks.
        }
      }
      return new URL(`${location.pathname}${location.search}${location.hash}`, origin).toString();
    } catch { return value; }
  }

  const server = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    const rawToken = headers[SESSION_HEADER];
    delete headers[SESSION_HEADER];
    headers.host = upstream.host;
    headers["x-forwarded-host"] = upstream.host;
    headers["x-forwarded-proto"] = upstream.protocol.slice(0, -1);
    // This trusted test proxy supplies the actual loopback peer, never an
    // inbound spoofable client-IP header.
    headers["x-forwarded-for"] = incoming.socket.remoteAddress;

    if (headers.origin === origin) {
      headers.origin = upstream.origin;
    }
    if (headers.referer) {
      try {
        const referer = new URL(headers.referer);
        if (referer.origin === origin) {
          headers.referer = new URL(`${referer.pathname}${referer.search}`, upstream).toString();
        }
      } catch {
        // Preserve invalid/foreign origins so framework CSRF checks reject them.
      }
    }

    if (typeof rawToken === "string") {
      const token = encodeURIComponent(rawToken);
      headers.cookie = `authjs.session-token=${token}; __Secure-authjs.session-token=${token}`;
    }

    const request = requestUpstream(new URL(incoming.url ?? "/", upstream), {
      method: incoming.method,
      headers,
    }, (response) => {
      const responseHeaders = { ...response.headers };
      if (responseHeaders.location) {
        responseHeaders.location = mapRedirect(responseHeaders.location);
      }
      // Next's client consumes Server Action redirects from this header rather
      // than Location. Preserve its navigation mode and foreign destinations.
      const actionRedirect = responseHeaders["x-action-redirect"];
      if (typeof actionRedirect === "string") {
        const parts = /^(.*);(push|replace)$/.exec(actionRedirect);
        responseHeaders["x-action-redirect"] = parts
          ? `${mapRedirect(parts[1])};${parts[2]}` : mapRedirect(actionRedirect);
      }
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders);
      response.pipe(outgoing);
    });
    request.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain" });
      }
      outgoing.end("Test proxy upstream unavailable.");
    });
    incoming.pipe(request);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The browser session proxy did not bind to loopback.");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
