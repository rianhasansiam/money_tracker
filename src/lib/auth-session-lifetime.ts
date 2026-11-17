import { AsyncLocalStorage } from "node:async_hooks";
import { AUTH_SESSION_MAX_AGE_SECONDS } from "@/lib/security-policy";

interface SessionLifetimeContext {
  deadline?: Date;
}

// Auth.js constructs renewal cookies independently of adapter.updateSession's
// result. Carry the verified deadline only within this HTTP request so both the
// catch-all route and Node.js Proxy can cap those cookies before sending them.
const sessionLifetime = new AsyncLocalStorage<SessionLifetimeContext>();
const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

export function getAbsoluteSessionDeadline(session: { createdAt?: unknown }) {
  if (
    !(session.createdAt instanceof Date) ||
    !Number.isFinite(session.createdAt.getTime())
  ) {
    return null;
  }

  return new Date(
    session.createdAt.getTime() + AUTH_SESSION_MAX_AGE_SECONDS * 1_000,
  );
}

export function recordSessionDeadline(deadline: Date) {
  const context = sessionLifetime.getStore();

  if (context) {
    context.deadline = deadline;
  }
}

function capSessionCookie(cookie: string, deadline: Date) {
  const [nameAndValue, ...attributes] = cookie.split(";");
  const name = nameAndValue.slice(0, nameAndValue.indexOf("=")).trim();

  if (!SESSION_COOKIE.test(name)) {
    return cookie;
  }

  let expires = deadline.getTime();
  const preserved: string[] = [];

  for (const attribute of attributes) {
    const normalized = attribute.trim();

    if (/^expires=/i.test(normalized)) {
      const original = Date.parse(normalized.slice("expires=".length));
      if (Number.isFinite(original)) {
        expires = Math.min(expires, original);
      }
    } else if (/^max-age=/i.test(normalized)) {
      const original = Number(normalized.slice("max-age=".length));
      const remaining = Math.max(
        0,
        Math.floor((deadline.getTime() - Date.now()) / 1_000),
      );
      preserved.push(
        `Max-Age=${Number.isFinite(original) ? Math.min(original, remaining) : remaining}`,
      );
    } else {
      preserved.push(normalized);
    }
  }

  return [
    nameAndValue,
    ...preserved,
    `Expires=${new Date(expires).toUTCString()}`,
  ].join("; ");
}

export async function withSessionCookieDeadline(
  operation: () => Promise<Response>,
): Promise<Response> {
  return sessionLifetime.run({}, async () => {
    const response = await operation();
    const deadline = sessionLifetime.getStore()?.deadline;

    if (!deadline || response.headers.getSetCookie().length === 0) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    for (const cookie of response.headers.getSetCookie()) {
      headers.append("set-cookie", capSessionCookie(cookie, deadline));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
