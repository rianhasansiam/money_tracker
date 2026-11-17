import type { ClientConfig } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseReadinessProbe } from "@/lib/readiness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function fakeClient() {
  return {
    connect: vi.fn<() => Promise<void>>(async () => undefined),
    query: vi.fn<(text: string, values?: string[]) => Promise<unknown>>(
      async () => [],
    ),
    end: vi.fn<() => Promise<void>>(async () => undefined),
    on: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isolated database readiness", () => {
  it("bounds connection and statement work without using the business pool", async () => {
    const client = fakeClient();
    const createClient = vi.fn<(config: ClientConfig) => typeof client>(() => client);
    const check = createDatabaseReadinessProbe({
      connectionString: () => "postgresql://synthetic.test/disposable_test",
      createClient,
    });

    await expect(check()).resolves.toBe(true);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 500,
      }),
    );
    expect(client.query.mock.calls).toEqual([
      ["BEGIN READ ONLY"],
      ["SELECT set_config('statement_timeout', $1, true)", ["1000"]],
      ["SELECT 1"],
      ["ROLLBACK"],
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping callers until actual cleanup completes", async () => {
    const client = fakeClient();
    const cleanup = deferred<void>();
    client.query.mockRejectedValueOnce(new Error("Synthetic unavailable store"));
    client.end.mockImplementationOnce(() => cleanup.promise);
    const createClient = vi.fn(() => client);
    const check = createDatabaseReadinessProbe({
      connectionString: () => "postgresql://synthetic.test/disposable_test",
      createClient,
    });

    const first = check();
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledTimes(1));
    const overlapping = Array.from({ length: 20 }, () => check());
    expect(overlapping.every((result) => result === first)).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(1);

    cleanup.resolve();
    await expect(first).resolves.toBe(false);
    await expect(Promise.all(overlapping)).resolves.toEqual(Array(20).fill(false));
    await expect(check()).resolves.toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("destroys stalled I/O and awaits disconnect at the hard deadline", async () => {
    vi.useFakeTimers();
    const query = deferred<unknown>();
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => query.promise);
    client.end.mockImplementation(async () => {
      query.reject(new Error("Connection terminated"));
    });
    const createClient = vi.fn<(config: ClientConfig) => typeof client>(() => client);
    const check = createDatabaseReadinessProbe({
      connectionString: () => "postgresql://synthetic.test/disposable_test",
      timeoutMs: 25,
      createClient,
    });

    const result = check();
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe(false);
    expect(client.end).toHaveBeenCalledTimes(1);
    const socket = createClient.mock.calls[0]?.[0].stream?.();
    expect(socket?.destroyed).toBe(true);
  });

  it("fails closed when configuration is absent and catches connection failure", async () => {
    const client = fakeClient();
    const createClient = vi.fn(() => client);
    const missing = createDatabaseReadinessProbe({
      connectionString: () => undefined,
      createClient,
    });
    await expect(missing()).resolves.toBe(false);
    expect(createClient).not.toHaveBeenCalled();

    client.connect.mockRejectedValueOnce(new Error("Synthetic connect failure"));
    const disconnected = createDatabaseReadinessProbe({
      connectionString: () => "postgresql://synthetic.test/disposable_test",
      createClient,
    });
    await expect(disconnected()).resolves.toBe(false);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Infinity, 1.5])("rejects an unbounded timeout %s", (timeoutMs) => {
    expect(() =>
      createDatabaseReadinessProbe({ connectionString: () => undefined, timeoutMs }),
    ).toThrow(RangeError);
  });
});
