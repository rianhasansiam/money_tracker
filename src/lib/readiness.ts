import { Socket } from "node:net";
import { Client, type ClientConfig } from "pg";

interface ReadinessClient {
  connect(): Promise<unknown>;
  query(text: string, values?: string[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface ReadinessProbeOptions {
  connectionString: () => string | undefined;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  timeoutMs?: number;
  /** Internal test seam; neither this nor the timeouts come from requests. */
  createClient?: (config: ClientConfig) => ReadinessClient;
}

function positiveTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Readiness timeouts must be positive integers.");
  }

  return value;
}

/**
 * One isolated connection per in-flight check, shared by concurrent callers.
 * PostgreSQL cancels slow statements; the owned socket bounds stalled I/O and
 * disconnects. The in-flight slot is retained until that connection is closed.
 */
export function createDatabaseReadinessProbe(options: ReadinessProbeOptions) {
  const connectionTimeoutMs = positiveTimeout(options.connectionTimeoutMs ?? 500);
  const statementTimeoutMs = positiveTimeout(options.statementTimeoutMs ?? 1_000);
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 2_000);
  const createClient = options.createClient ?? ((config) => new Client(config));
  let inFlight: Promise<boolean> | undefined;

  async function run() {
    let client: ReadinessClient | undefined;
    let socket: Socket | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    let timedOut = false;
    let ready = false;

    function close() {
      if (!closing) {
        closing = Promise.resolve()
          .then(() => client?.end())
          .catch(() => {
            ready = false;
          });
      }

      return closing;
    }

    try {
      const connectionString = options.connectionString()?.trim();

      if (!connectionString) {
        return false;
      }

      socket = new Socket();
      client = createClient({
        connectionString,
        connectionTimeoutMillis: connectionTimeoutMs,
        application_name: "money-tracker-readiness",
        // pg's supported stream factory also works with its TLS negotiation;
        // retaining the underlying socket lets the hard deadline destroy I/O.
        stream: () => socket,
      });
      // Idle/disconnect errors must not become unhandled EventEmitter errors.
      client.on("error", () => {
        ready = false;
      });
      timeout = setTimeout(() => {
        timedOut = true;
        socket?.destroy();
        void close();
      }, timeoutMs);

      await client.connect();
      // A transaction pins the backend even behind a transaction pooler.
      // Keep the bound local so it cannot leak into a later business query.
      // SQL setup also avoids poolers that reject startup timeout parameters.
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(statementTimeoutMs),
      ]);
      await client.query("SELECT 1");
      await client.query("ROLLBACK");
      ready = !timedOut;
    } catch {
      ready = false;
    } finally {
      // Do not report completion or admit another check while cleanup waits.
      await close();
      socket?.destroy();

      if (timeout) {
        clearTimeout(timeout);
      }
    }

    return ready && !timedOut;
  }

  return function check() {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
    }

    return inFlight;
  };
}

export const checkDatabaseReadiness = createDatabaseReadinessProbe({
  connectionString: () => process.env.DATABASE_URL,
});
