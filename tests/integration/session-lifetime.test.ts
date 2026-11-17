import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHardenedPrismaAdapter, hashSessionToken } from "@/lib/auth-adapter";
import { isPostgresTestDatabaseConfigured, openPostgresTestHarness, type PostgresTestHarness } from "../helpers/postgres-test-harness";

const describeWithDatabase = isPostgresTestDatabaseConfigured() ? describe : describe.skip;
const EIGHT_HOURS = 8 * 60 * 60_000;

describeWithDatabase("PostgreSQL absolute session lifetime", () => {
  let harness: PostgresTestHarness;
  let userId: string;
  beforeAll(async () => {
    harness = await openPostgresTestHarness();
    await harness.clean();
    userId = (await harness.db.user.create({ data: {
      email: "adapter-session-boundary@example.test", status: "ACTIVE", role: "ADMIN",
    } })).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => harness?.close());

  it("persists creation time and capped expiry while storing only the token digest", async () => {
    const adapter = createHardenedPrismaAdapter(harness.db);
    const rawToken = randomUUID();
    const returned = await adapter.createSession!({ sessionToken: rawToken, userId, expires: new Date(Date.now() + 24 * 60 * 60_000) });
    const stored = await harness.db.session.findUniqueOrThrow({ where: { sessionToken: hashSessionToken(rawToken) } });
    expect(stored.expires.getTime()).toBe(stored.createdAt.getTime() + EIGHT_HOURS);
    expect(returned?.expires).toEqual(stored.expires);
    expect(returned?.sessionToken).toBe(rawToken);
    expect(await harness.db.session.count({ where: { sessionToken: rawToken } })).toBe(0);
  });

  it("keeps repeated renewal inside one immutable deadline and cleans lookup/update exactly at it", async () => {
    const createdAt = new Date();
    const deadline = new Date(createdAt.getTime() + EIGHT_HOURS);
    const rawToken = randomUUID();
    const digest = hashSessionToken(rawToken);
    await harness.db.session.create({ data: { userId, sessionToken: digest, createdAt, expires: new Date(createdAt.getTime() + 60 * 60_000) } });
    const adapter = createHardenedPrismaAdapter(harness.db);
    const clock = vi.spyOn(Date, "now");
    for (const elapsed of [30 * 60_000, 4 * 60 * 60_000, EIGHT_HOURS - 1]) {
      clock.mockReturnValue(createdAt.getTime() + elapsed);
      const renewed = await adapter.updateSession!({ sessionToken: rawToken, expires: new Date(createdAt.getTime() + elapsed + EIGHT_HOURS) });
      expect(renewed?.expires).toEqual(deadline);
      expect((await adapter.getSessionAndUser!(rawToken))?.session.expires).toEqual(deadline);
      const stored = await harness.db.session.findUniqueOrThrow({ where: { sessionToken: digest } });
      expect(stored.createdAt).toEqual(createdAt);
      expect(stored.expires).toEqual(deadline);
    }
    clock.mockReturnValue(deadline.getTime());
    expect(await adapter.getSessionAndUser!(rawToken)).toBeNull();
    expect(await harness.db.session.count({ where: { sessionToken: digest } })).toBe(0);
    await harness.db.session.create({ data: { userId, sessionToken: digest, createdAt, expires: new Date(deadline.getTime() + EIGHT_HOURS) } });
    expect(await adapter.updateSession!({ sessionToken: rawToken, expires: new Date(deadline.getTime() + EIGHT_HOURS) })).toBeNull();
    expect(await harness.db.session.count({ where: { sessionToken: digest } })).toBe(0);
  });

  it("rejects a nine-hour legacy session with future rolling expiry", async () => {
    const rawToken = randomUUID();
    const digest = hashSessionToken(rawToken);
    await harness.db.session.create({ data: {
      userId, sessionToken: digest, createdAt: new Date(Date.now() - 9 * 60 * 60_000), expires: new Date(Date.now() + 60 * 60_000),
    } });
    expect(await createHardenedPrismaAdapter(harness.db).getSessionAndUser!(rawToken)).toBeNull();
    expect(await harness.db.session.count({ where: { sessionToken: digest } })).toBe(0);
  });

  it("normalizes only still-valid legacy rolling expiries before returning the session", async () => {
    const createdAt = new Date();
    const deadline = new Date(createdAt.getTime() + EIGHT_HOURS);
    const adapter = createHardenedPrismaAdapter(harness.db);
    const token = randomUUID();
    await harness.db.session.create({ data: {
      userId, sessionToken: hashSessionToken(token), createdAt, expires: new Date(Date.now() + 60_000),
    } });
    expect((await adapter.getSessionAndUser!(token))?.session.expires).toEqual(deadline);
    expect((await harness.db.session.findUniqueOrThrow({ where: { sessionToken: hashSessionToken(token) } })).expires).toEqual(deadline);

    const expiredToken = randomUUID();
    await harness.db.session.create({ data: {
      userId, sessionToken: hashSessionToken(expiredToken), createdAt, expires: new Date(Date.now() - 1),
    } });
    expect(await adapter.getSessionAndUser!(expiredToken)).toBeNull();
    expect(await harness.db.session.count({ where: { sessionToken: hashSessionToken(expiredToken) } })).toBe(0);
  });
});
