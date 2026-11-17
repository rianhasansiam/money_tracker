import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterAccount,
  AdapterSession,
  AdapterUser,
} from "next-auth/adapters";
import {
  hardenAuthAdapter,
  hashSessionToken,
} from "@/lib/auth-adapter";

const rawSessionToken = "opaque-browser-session-token";
const activeUser = {
  id: "user-active",
  name: "Active user",
  email: "active@example.test",
  emailVerified: null,
  image: null,
  status: "ACTIVE",
  disabledAt: null,
  deletedAt: null,
} as AdapterUser & {
  status: string;
  disabledAt: Date | null;
  deletedAt: Date | null;
};

const createdAt = new Date("2026-11-16T00:00:00.000Z");
const deadline = new Date("2026-11-16T08:00:00.000Z");

function session(sessionToken = rawSessionToken): AdapterSession & { createdAt: Date } {
  return {
    sessionToken,
    userId: activeUser.id,
    createdAt,
    expires: deadline,
  };
}

describe("security-hardened Auth.js adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(createdAt);
  });
  afterEach(() => vi.useRealTimers());
  it("never gives provider bearer/token metadata to persistent storage", async () => {
    const linkAccount = vi.fn(async (account: AdapterAccount) => account);
    const adapter = hardenAuthAdapter({ linkAccount });
    const account: AdapterAccount = {
      userId: activeUser.id,
      type: "oauth",
      provider: "google",
      providerAccountId: "provider-account",
      access_token: "access-value",
      refresh_token: "refresh-value",
      id_token: "identity-value",
      session_state: "provider-session",
      scope: "openid email profile",
      token_type: "bearer",
      expires_at: 1_800_000_000,
    };

    const returned = await adapter.linkAccount?.(account);
    const persisted = linkAccount.mock.calls[0]?.[0];

    expect(persisted).toMatchObject({
      userId: activeUser.id,
      provider: "google",
      providerAccountId: "provider-account",
    });

    for (const field of [
      "access_token",
      "refresh_token",
      "id_token",
      "session_state",
      "scope",
      "token_type",
      "expires_at",
    ]) {
      expect(persisted).not.toHaveProperty(field);
      expect(returned).not.toHaveProperty(field);
    }
  });

  it("stores only a digest on create while returning the raw value to Auth.js", async () => {
    const createSession = vi.fn(async (value: AdapterSession) => value);
    const adapter = hardenAuthAdapter({ createSession });

    const created = await adapter.createSession?.(session());

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: hashSessionToken(rawSessionToken),
      }),
    );
    expect(created?.sessionToken).toBe(rawSessionToken);
    expect(hashSessionToken(rawSessionToken)).not.toContain(rawSessionToken);
  });

  it("looks up a migrated digest and restores the raw cookie value", async () => {
    const storedDigest = hashSessionToken(rawSessionToken);
    const getSessionAndUser = vi.fn(async (lookupToken: string) =>
      lookupToken === storedDigest
        ? {
            user: activeUser,
            session: session(storedDigest),
          }
        : null,
    );
    const adapter = hardenAuthAdapter({ getSessionAndUser });

    const result = await adapter.getSessionAndUser?.(rawSessionToken);

    expect(getSessionAndUser).toHaveBeenCalledWith(storedDigest);
    expect(result?.session.sessionToken).toBe(rawSessionToken);
  });

  it("hashes update/delete lookups but preserves Auth.js' raw return contract", async () => {
    const updateSession = vi.fn(async (value: AdapterSession) => value);
    const deleteSession = vi.fn(async (lookupToken: string) =>
      session(lookupToken),
    );
    const adapter = hardenAuthAdapter({
      updateSession,
      deleteSession,
      getSessionAndUser: async () => ({
        user: activeUser,
        session: { ...session(hashSessionToken(rawSessionToken)), expires: new Date(createdAt.getTime() + 60 * 60 * 1000) },
      }),
    });

    const updated = await adapter.updateSession?.(session());
    const deleted = await adapter.deleteSession?.(rawSessionToken);
    const digest = hashSessionToken(rawSessionToken);

    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: digest }),
    );
    expect(deleteSession).toHaveBeenCalledWith(digest);
    expect(updated?.sessionToken).toBe(rawSessionToken);
    expect(deleted && "sessionToken" in deleted
      ? deleted.sessionToken
      : undefined).toBe(rawSessionToken);
  });

  it("rejects an offboarded user on the next lookup and removes the session", async () => {
    const digest = hashSessionToken(rawSessionToken);
    const getSessionAndUser = vi.fn(async () => ({
      user: {
        ...activeUser,
        status: "DISABLED",
        disabledAt: new Date("2026-07-15T10:00:00.000Z"),
      },
      session: session(digest),
    }));
    const deleteSession = vi.fn(async () => session(digest));
    const adapter = hardenAuthAdapter({ getSessionAndUser, deleteSession });

    await expect(adapter.getSessionAndUser?.(rawSessionToken)).resolves.toBeNull();
    expect(deleteSession).toHaveBeenCalledWith(digest);
  });

  it("fails closed when concurrent revocation already removed an inactive session", async () => {
    const digest = hashSessionToken(rawSessionToken);
    const getSessionAndUser = vi.fn(async () => ({
      user: {
        ...activeUser,
        status: "DISABLED",
        disabledAt: new Date("2026-07-15T10:00:00.000Z"),
      },
      session: session(digest),
    }));
    const deleteSession = vi.fn(async () => {
      throw Object.assign(new Error("Synthetic concurrent revocation"), {
        code: "P2025",
      });
    });
    const adapter = hardenAuthAdapter({ getSessionAndUser, deleteSession });

    await expect(adapter.getSessionAndUser?.(rawSessionToken)).resolves.toBeNull();
  });

  it("caps session creation, repairs legacy expiry, and returns the fixed deadline", async () => {
    const createSession = vi.fn(async (value: AdapterSession) => value);
    const updateSession = vi.fn(async (value: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">) => ({ ...session(value.sessionToken), ...value }));
    const adapter = hardenAuthAdapter({
      createSession,
      updateSession,
      getSessionAndUser: async () => ({
        user: activeUser,
        session: { ...session(hashSessionToken(rawSessionToken)), expires: new Date("2026-11-17T00:00:00.000Z") },
      }),
    });
    const created = await adapter.createSession?.({ ...session(), expires: new Date("2026-11-17T00:00:00.000Z") });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ createdAt, expires: deadline }));
    expect(created?.expires).toEqual(deadline);
    const read = await adapter.getSessionAndUser?.(rawSessionToken);
    expect(read?.session.expires).toEqual(deadline);
    expect(updateSession).toHaveBeenCalledWith({ sessionToken: hashSessionToken(rawSessionToken), expires: deadline });
  });

  it("does not extend the deadline after repeated renewal or change creation/ownership", async () => {
    let stored = { ...session(hashSessionToken(rawSessionToken)), expires: new Date(createdAt.getTime() + 60 * 60 * 1000) };
    const updateSession = vi.fn(async (value: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">) => {
      stored = { ...stored, ...value };
      return stored;
    });
    const adapter = hardenAuthAdapter({
      getSessionAndUser: async () => ({ user: activeUser, session: stored }),
      updateSession,
    });
    for (const elapsed of [30 * 60_000, 4 * 60 * 60_000, 8 * 60 * 60_000 - 1]) {
      vi.setSystemTime(createdAt.getTime() + elapsed);
      const renewed = await adapter.updateSession?.({
        sessionToken: rawSessionToken,
        expires: new Date(Date.now() + 8 * 60 * 60_000),
        userId: "another-user",
      });
      expect(renewed?.expires).toEqual(deadline);
      expect(stored.createdAt).toEqual(createdAt);
      expect(stored.userId).toBe(activeUser.id);
    }
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it("normalizes a still-valid shorter legacy expiry before Auth.js consumes it", async () => {
    vi.setSystemTime(createdAt.getTime() + 30 * 60_000);
    const updateSession = vi.fn(async (value: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">) => ({ ...session(value.sessionToken), ...value }));
    const deleteSession = vi.fn(async () => session());
    const adapter = hardenAuthAdapter({
      getSessionAndUser: async () => ({
        user: activeUser,
        session: { ...session(), expires: new Date(createdAt.getTime() + 60 * 60_000) },
      }),
      updateSession,
      deleteSession,
    });
    expect((await adapter.getSessionAndUser?.(rawSessionToken))?.session.expires).toEqual(deadline);
    expect(updateSession).toHaveBeenCalledWith({ sessionToken: hashSessionToken(rawSessionToken), expires: deadline });
    vi.setSystemTime(createdAt.getTime() + 60 * 60_000);
    expect(await adapter.getSessionAndUser?.(rawSessionToken)).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith(hashSessionToken(rawSessionToken));
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it.each([8 * 60 * 60_000, 8 * 60 * 60_000 + 1, 9 * 60 * 60_000])(
    "rejects and cleans lookup/update at elapsed %i even with future rolling expiry",
    async (elapsed) => {
      vi.setSystemTime(createdAt.getTime() + elapsed);
      const deleteSession = vi.fn(async () => session());
      const updateSession = vi.fn(async (value: AdapterSession) => value);
      const adapter = hardenAuthAdapter({
        getSessionAndUser: async () => ({
          user: activeUser,
          session: { ...session(), expires: new Date(Date.now() + 60 * 60_000) },
        }),
        updateSession,
        deleteSession,
      });
      expect(await adapter.getSessionAndUser?.(rawSessionToken)).toBeNull();
      expect(await adapter.updateSession?.({ sessionToken: rawSessionToken, expires: new Date(Date.now() + 8 * 60 * 60_000) })).toBeNull();
      expect(deleteSession).toHaveBeenCalledWith(hashSessionToken(rawSessionToken));
      expect(updateSession).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a persisted session missing its immutable creation timestamp", async () => {
    const deleteSession = vi.fn(async () => session());
    const adapter = hardenAuthAdapter({
      getSessionAndUser: async () => ({ user: activeUser, session: { sessionToken: rawSessionToken, userId: activeUser.id, expires: deadline } }),
      deleteSession,
    });
    expect(await adapter.getSessionAndUser?.(rawSessionToken)).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith(hashSessionToken(rawSessionToken));
  });
});
