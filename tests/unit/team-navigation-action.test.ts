import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  class RateLimitExceededError extends Error { constructor(public retryAfterSeconds: number) { super("rate limited"); } }
  class RateLimitUnavailableError extends Error {}
  return { auth: vi.fn(), page: vi.fn(), limit: vi.fn(), RateLimitExceededError, RateLimitUnavailableError };
});
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/queries/teams", () => ({ getApprovedTeamsPage: mocks.page }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.limit, RateLimitExceededError: mocks.RateLimitExceededError, RateLimitUnavailableError: mocks.RateLimitUnavailableError }));
import { loadApprovedTeamOptions } from "@/actions/team-navigation";
const cursor = "clh1234567890abcdefghijk";

describe("team switcher action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "authenticated-viewer" } });
    mocks.limit.mockResolvedValue(undefined);
    mocks.page.mockResolvedValue({ teams: [], nextCursor: null });
  });
  it("uses the authenticated actor rather than a caller-provided identity", async () => {
    expect(await loadApprovedTeamOptions(cursor)).toEqual({ status: "success", page: { teams: [], nextCursor: null } });
    expect(mocks.page).toHaveBeenCalledWith("authenticated-viewer", cursor);
    expect(mocks.limit).toHaveBeenCalledWith({ scope: "team-switcher", userId: "authenticated-viewer", limit: 45, windowSeconds: 60 });
  });
  it("rejects anonymous and malformed requests before database reads", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect(await loadApprovedTeamOptions(cursor)).toMatchObject({ status: "error" });
    expect(await loadApprovedTeamOptions("invalid")).toMatchObject({ status: "error" });
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
  });
  it("keeps protection fail-closed and preserves server retry timing", async () => {
    mocks.limit.mockRejectedValueOnce(new mocks.RateLimitExceededError(17));
    expect(await loadApprovedTeamOptions()).toMatchObject({ status: "error", retryAfterSeconds: 17 });
    mocks.limit.mockRejectedValueOnce(new mocks.RateLimitUnavailableError());
    expect(await loadApprovedTeamOptions()).toMatchObject({ status: "error", message: expect.stringContaining("temporarily unavailable") });
    expect(mocks.page).not.toHaveBeenCalled();
  });
});
