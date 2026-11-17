import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHistoryCursor, encodeHistoryCursor } from "@/lib/history-cursor";

const payload = {
  id: "clh1234567890abcdefghijk",
  scope: "a".repeat(64), filters: "b".repeat(64), revision: "c".repeat(64),
};
beforeEach(() => vi.stubEnv("AUTH_SECRET", "synthetic-history-cursor-unit-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("signed history cursor integrity", () => {
  it("round-trips a bounded actor/team/filter/revision cursor", () => {
    const cursor = encodeHistoryCursor(payload);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(decodeHistoryCursor(cursor)).toEqual({ v: 1, ...payload });
  });

  it("rejects changed payloads and signatures", () => {
    const cursor = encodeHistoryCursor(payload);
    const [encoded, signature] = cursor.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, ...payload, id: "clh1234567890abcdefghijl" })).toString("base64url");
    expect(decodeHistoryCursor(`${forgedPayload}.${signature}`)).toBeNull();
    expect(decodeHistoryCursor(`${encoded}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`)).toBeNull();
  });

  it.each(["not-a-cursor", "a".repeat(513), "e30=.invalid", "e30.short"])("rejects malformed token %s", (cursor) => {
    expect(decodeHistoryCursor(cursor)).toBeNull();
  });

  it("rejects signed but structurally invalid payloads", () => {
    expect(decodeHistoryCursor(encodeHistoryCursor({ ...payload, id: "not-an-id" }))).toBeNull();
  });

  it("fails closed without the existing authentication secret", () => {
    const cursor = encodeHistoryCursor(payload);
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => encodeHistoryCursor(payload)).toThrow("protection is unavailable");
    expect(() => decodeHistoryCursor(cursor)).toThrow("protection is unavailable");
  });
});
