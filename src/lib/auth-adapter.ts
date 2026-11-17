import { createHash } from "node:crypto";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { PrismaClient } from "@prisma/client";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
} from "next-auth/adapters";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";
import { isActiveUserState } from "@/lib/security-policy";
import {
  getAbsoluteSessionDeadline,
  recordSessionDeadline,
} from "@/lib/auth-session-lifetime";

type PersistedSession = AdapterSession & { createdAt?: Date };

const PROVIDER_TOKEN_FIELDS = [
  "refresh_token",
  "access_token",
  "expires_at",
  "token_type",
  "scope",
  "id_token",
  "session_state",
] as const;

export function hashSessionToken(sessionToken: string) {
  return createHash("sha256").update(sessionToken, "utf8").digest("hex");
}

function minimizeProviderAccount<T extends AdapterAccount>(account: T): T {
  const minimized = { ...account };

  for (const field of PROVIDER_TOKEN_FIELDS) {
    delete minimized[field];
  }

  return minimized;
}

function restoreRawSessionToken<T extends AdapterSession>(
  session: T,
  rawSessionToken: string,
): T {
  return {
    ...session,
    sessionToken: rawSessionToken,
  };
}

/**
 * Keeps Auth.js' public adapter contract while reducing the value of a
 * database read compromise. Provider bearer material is not persisted, and
 * the database stores only SHA-256 digests of high-entropy session tokens.
 */
export function hardenAuthAdapter(baseAdapter: Adapter): Adapter {
  const linkAccount = baseAdapter.linkAccount;
  const createSession = baseAdapter.createSession;
  const getSessionAndUser = baseAdapter.getSessionAndUser;
  const updateSession = baseAdapter.updateSession;
  const deleteSession = baseAdapter.deleteSession;

  async function removeInvalidSession(hashedToken: string) {
    try {
      await deleteSession?.(hashedToken);
    } catch (error) {
      if (!hasPrismaErrorCode(error, "P2025")) {
        throw error;
      }
    }
  }

  async function readValidSession(hashedToken: string) {
    const result = await getSessionAndUser?.(hashedToken);
    if (!result) {
      return null;
    }

    const deadline = getAbsoluteSessionDeadline(result.session as PersistedSession);
    if (
      !deadline ||
      Date.now() >= deadline.getTime() ||
      Date.now() >= result.session.expires.getTime() ||
      !isActiveUserState(result.user as typeof result.user & {
        status?: string | null;
        disabledAt?: Date | null;
        deletedAt?: Date | null;
      })
    ) {
      await removeInvalidSession(hashedToken);
      return null;
    }

    recordSessionDeadline(deadline);
    return { ...result, deadline };
  }

  return {
    ...baseAdapter,
    ...(linkAccount
      ? {
          async linkAccount(
            account: AdapterAccount,
          ): Promise<AdapterAccount | null | undefined> {
            const result = await linkAccount(minimizeProviderAccount(account));

            return result && typeof result === "object"
              ? minimizeProviderAccount(result)
              : (result as AdapterAccount | null | undefined);
          },
        }
      : {}),
    ...(createSession
      ? {
          async createSession(session: AdapterSession) {
            const createdAt = new Date();
            const deadline = getAbsoluteSessionDeadline({ createdAt })!;
            const persisted = await createSession({
              ...session,
              createdAt,
              expires: new Date(Math.min(session.expires.getTime(), deadline.getTime())),
              sessionToken: hashSessionToken(session.sessionToken),
            } as PersistedSession);

            recordSessionDeadline(deadline);

            return restoreRawSessionToken(persisted, session.sessionToken);
          },
        }
      : {}),
    ...(getSessionAndUser
      ? {
          async getSessionAndUser(rawSessionToken: string) {
            const hashedSessionToken = hashSessionToken(rawSessionToken);
            const result = await readValidSession(hashedSessionToken);

            if (!result) {
              return null;
            }

            const expires = result.deadline;
            // A still-valid legacy session may have either a shorter rolling
            // expiry or one beyond the absolute deadline. Normalize it before
            // Auth.js reads it: core ignores updateSession's return value when
            // constructing the public session. Expired sessions were already
            // rejected above, so normalization cannot revive them.
            if (expires.getTime() !== result.session.expires.getTime()) {
              await updateSession?.({ sessionToken: hashedSessionToken, expires });
            }

            return {
              user: result.user,
              session: restoreRawSessionToken(
                { ...result.session, expires },
                rawSessionToken,
              ),
            };
          },
        }
      : {}),
    ...(updateSession
      ? {
          async updateSession(
            session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">,
          ): Promise<AdapterSession | null | undefined> {
            const rawSessionToken = session.sessionToken;
            const hashedToken = hashSessionToken(rawSessionToken);
            const current = await readValidSession(hashedToken);
            if (!current) {
              return null;
            }

            const expires = new Date(Math.min(
              (session.expires ?? current.session.expires).getTime(),
              current.deadline.getTime(),
            ));
            // Never forward creation time or user identity in an update. Those
            // fields anchor the absolute lifetime and session ownership.
            const persisted = expires.getTime() === current.session.expires.getTime()
              ? current.session
              : await updateSession({ sessionToken: hashedToken, expires });

            return persisted
              ? restoreRawSessionToken(persisted, rawSessionToken)
              : persisted;
          },
        }
      : {}),
    ...(deleteSession
      ? {
          async deleteSession(
            rawSessionToken: string,
          ): Promise<AdapterSession | null | undefined> {
            const deleted = await deleteSession(hashSessionToken(rawSessionToken));

            return deleted
              ? restoreRawSessionToken(deleted, rawSessionToken)
              : (deleted as AdapterSession | null | undefined);
          },
        }
      : {}),
  };
}

export function createHardenedPrismaAdapter(database: PrismaClient) {
  return hardenAuthAdapter(PrismaAdapter(database));
}
