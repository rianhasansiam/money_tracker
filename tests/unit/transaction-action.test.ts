import { beforeEach, describe, expect, it, vi } from "vitest";

const actionMocks = vi.hoisted(() => {
  class InsufficientBalanceError extends Error {
    constructor(public readonly balanceInCents: number) {
      super("Insufficient balance.");
    }
  }

  class IdempotencyConflictError extends Error {}
  class InvalidTransactionInputError extends Error {}
  class TransactionConflictError extends Error {}
  class UnauthorizedTransactionError extends Error {}
  class RateLimitExceededError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("Rate limit exceeded.");
    }
  }
  class RateLimitUnavailableError extends Error {}

  return {
    auth: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    createTeamTransaction: vi.fn<
      (
        actorId: string,
        input: unknown,
      ) => Promise<{ transaction: { id: string }; replayed: boolean }>
    >(),
    IdempotencyConflictError,
    InsufficientBalanceError,
    InvalidTransactionInputError,
    enforceUserRateLimit: vi.fn<() => Promise<unknown>>(),
    RateLimitExceededError,
    RateLimitUnavailableError,
    refresh: vi.fn(),
    revalidatePath: vi.fn(),
    TransactionConflictError,
    UnauthorizedTransactionError,
  };
});

vi.mock("next/cache", () => ({
  refresh: actionMocks.refresh,
  revalidatePath: actionMocks.revalidatePath,
}));

vi.mock("@/lib/auth", () => ({
  auth: actionMocks.auth,
}));

vi.mock("@/lib/data/transactions", () => ({
  createTeamTransaction: actionMocks.createTeamTransaction,
  IdempotencyConflictError: actionMocks.IdempotencyConflictError,
  InsufficientBalanceError: actionMocks.InsufficientBalanceError,
  InvalidTransactionInputError: actionMocks.InvalidTransactionInputError,
  TransactionConflictError: actionMocks.TransactionConflictError,
  UnauthorizedTransactionError: actionMocks.UnauthorizedTransactionError,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: actionMocks.enforceUserRateLimit,
  RateLimitExceededError: actionMocks.RateLimitExceededError,
  RateLimitUnavailableError: actionMocks.RateLimitUnavailableError,
}));

import { createTransaction } from "@/actions/transactions";

const validTeamId = "clh1234567890abcdefghijk";
const operationKey = "00000000-0000-4000-8000-000000000000";
const validInput = {
  amount: "1,000.50",
  note: "Office supplies",
  transactionDate: "2024-02-29",
  type: "ADD" as const,
};

describe("createTransaction action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionMocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    actionMocks.createTeamTransaction.mockResolvedValue({
      transaction: { id: "transaction-1" },
      replayed: false,
    });
    actionMocks.enforceUserRateLimit.mockResolvedValue({
      allowed: true,
    });
  });

  it("rejects an anonymous write before validation, rate-limit, or ledger work", async () => {
    actionMocks.auth.mockResolvedValue(null);

    await expect(
      createTransaction(validTeamId, operationKey, validInput),
    ).resolves.toEqual({
      status: "error",
      message: "Your session has expired. Please sign in again.",
    });
    expect(actionMocks.enforceUserRateLimit).not.toHaveBeenCalled();
    expect(actionMocks.createTeamTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["oversized", `c${"x".repeat(64)}`],
    ["malformed", "not-a-cuid"],
  ])("rejects a %s team ID before database work", async (_label, teamId) => {
    const result = await createTransaction(
      teamId as string,
      operationKey,
      validInput,
    );

    expect(result).toMatchObject({
      status: "error",
      message:
        "This team is unavailable or you do not have permission to change its ledger.",
    });
    expect(actionMocks.createTeamTransaction).not.toHaveBeenCalled();
  });

  it("returns the same resource error for an unknown or cross-team ID", async () => {
    actionMocks.createTeamTransaction.mockRejectedValue(
      new actionMocks.UnauthorizedTransactionError(),
    );

    const result = await createTransaction(validTeamId, operationKey, validInput);

    expect(result).toMatchObject({
      status: "error",
      message:
        "This team is unavailable or you do not have permission to change its ledger.",
    });
  });

  it("passes a validated operation key into the atomic write", async () => {
    const result = await createTransaction(validTeamId, operationKey, validInput);

    expect(result).toMatchObject({
      status: "success",
      transactionId: "transaction-1",
      replayed: false,
      viewsUpdated: true,
    });
    expect(actionMocks.createTeamTransaction).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        teamId: validTeamId,
        idempotencyKey: operationKey,
      }),
    );
    expect(actionMocks.enforceUserRateLimit).toHaveBeenCalledWith({
      scope: "transaction-create",
      userId: "user-1",
      limit: 60,
      windowSeconds: 60,
    });
  });

  it("fails closed with retry information before financial work", async () => {
    actionMocks.enforceUserRateLimit.mockRejectedValue(
      new actionMocks.RateLimitExceededError(17),
    );

    const result = await createTransaction(validTeamId, operationKey, validInput);

    expect(result).toMatchObject({
      status: "error",
      retryAfterSeconds: 17,
    });
    expect(result.message).toContain("No transaction was attempted");
    expect(actionMocks.createTeamTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when the durable limiter is unavailable", async () => {
    actionMocks.enforceUserRateLimit.mockRejectedValue(
      new actionMocks.RateLimitUnavailableError(),
    );

    const result = await createTransaction(validTeamId, operationKey, validInput);

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.message).toContain("No transaction was attempted");
    expect(actionMocks.createTeamTransaction).not.toHaveBeenCalled();
  });

  it("returns committed success when cache refresh fails", async () => {
    actionMocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("Cache unavailable");
    });

    const result = await createTransaction(validTeamId, operationKey, validInput);

    expect(result).toMatchObject({
      status: "success",
      transactionId: "transaction-1",
      viewsUpdated: false,
    });
    expect(result.message).toContain("The ledger is saved");
  });

  it("marks an unclassified write failure as an unknown outcome for unchanged-key recovery", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    actionMocks.createTeamTransaction.mockRejectedValueOnce(new Error("Acknowledgement unavailable"));
    try {
      const result = await createTransaction(validTeamId, operationKey, validInput);
      expect(result).toMatchObject({ status: "error", code: "OUTCOME_UNKNOWN" });
      expect(result.message).toContain("Submit the unchanged form again");
      expect(actionMocks.refresh).not.toHaveBeenCalled();
      expect(actionMocks.createTeamTransaction).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });
});
