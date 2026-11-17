import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { Client, type ClientConfig } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseReadinessProbe } from "@/lib/readiness";
import {
  POSTGRES_TEST_SKIP_REASON,
  type PostgresTestHarness,
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
} from "../helpers/postgres-test-harness";
import { validateTestDatabaseEnvironment } from "../helpers/test-database-safety";

describe("readiness database resource lifetime", () => {
  if (!isPostgresTestDatabaseConfigured()) {
    it.skip(POSTGRES_TEST_SKIP_REASON, () => undefined);
    return;
  }

  let harness: PostgresTestHarness;
  let connectionString: string;

  beforeAll(async () => {
    const approved = validateTestDatabaseEnvironment();
    harness = await openPostgresTestHarness();
    connectionString = approved.connectionString;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("restores the backend's prior timeout before a successful probe releases it", async () => {
    let restoredTimeout: string | undefined;
    const check = createDatabaseReadinessProbe({
      connectionString: () => connectionString,
      statementTimeoutMs: 100,
      createClient(config) {
        const client = new Client({ ...config, statement_timeout: 5_000 });

        return {
          connect: () => client.connect(),
          on: (_event, listener) => client.on("error", listener),
          end: () => client.end(),
          async query(text, values) {
            const result = await client.query(text, values);
            if (text === "ROLLBACK") {
              const setting = await client.query<{ statement_timeout: string }>(
                "SHOW statement_timeout",
              );
              restoredTimeout = setting.rows[0]?.statement_timeout;
            }
            return result;
          },
        };
      },
    });

    await expect(check()).resolves.toBe(true);
    expect(restoredTimeout).toBe("5s");
  });

  it("cancels slow statements, coalesces probes, and leaves business queries available", async () => {
    const applicationName = `readiness-regression-${randomUUID()}`;
    const cancellationCodes: string[] = [];
    let clientsCreated = 0;
    let notifyQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      notifyQueryStarted = resolve;
    });
    const createClient = (config: ClientConfig) => {
      clientsCreated += 1;
      const client = new Client({ ...config, application_name: applicationName });

      return {
        connect: () => client.connect(),
        on: (_event: "error", listener: (error: Error) => void) =>
          client.on("error", listener),
        end: () => client.end(),
        async query(text: string, values?: string[]) {
          if (text !== "SELECT 1") {
            return client.query(text, values);
          }

          notifyQueryStarted();
          try {
            return await client.query("SELECT pg_sleep(2)");
          } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error) {
              cancellationCodes.push(String(error.code));
            }
            throw error;
          }
        },
      };
    };
    const check = createDatabaseReadinessProbe({
      connectionString: () => connectionString,
      connectionTimeoutMs: 100,
      statementTimeoutMs: 100,
      timeoutMs: 500,
      createClient,
    });

    const startedAt = Date.now();
    const requests = Array.from({ length: 20 }, () => check());
    await queryStarted;
    await expect(harness.db.$queryRaw`SELECT 1 AS available`).resolves.toEqual([
      { available: 1 },
    ]);
    await expect(Promise.all(requests)).resolves.toEqual(Array(20).fill(false));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(clientsCreated).toBe(1);
    expect(cancellationCodes).toEqual(["57014"]);

    await expect.poll(async () => {
      const rows = await harness.db.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::integer AS count
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
      `;
      return rows[0]?.count;
    }, { timeout: 1_000 }).toBe(0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(check()).resolves.toBe(false);
    }
    expect(clientsCreated).toBe(4);
    expect(cancellationCodes).toEqual(Array(4).fill("57014"));
    await expect(harness.db.$queryRaw`SELECT 1 AS available`).resolves.toEqual([
      { available: 1 },
    ]);
  });

  it("bounds a real stalled PostgreSQL handshake and closes its socket", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      // Deliberately accept TCP without replying to the PostgreSQL startup.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("The synthetic readiness listener failed to bind.");
      }
      const check = createDatabaseReadinessProbe({
        connectionString: () =>
          `postgresql://synthetic@127.0.0.1:${address.port}/disposable_test`,
        connectionTimeoutMs: 40,
        statementTimeoutMs: 50,
        timeoutMs: 150,
      });
      const startedAt = Date.now();

      await expect(check()).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect.poll(() => sockets.size, { timeout: 1_000 }).toBe(0);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
