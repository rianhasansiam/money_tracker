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
            const persisted = await createSession({
              ...session,
              sessionToken: hashSessionToken(session.sessionToken),
            });

            return restoreRawSessionToken(persisted, session.sessionToken);
          },
        }
      : {}),
    ...(getSessionAndUser
      ? {
          async getSessionAndUser(rawSessionToken: string) {
            const hashedSessionToken = hashSessionToken(rawSessionToken);
            const result = await getSessionAndUser(hashedSessionToken);

            if (!result) {
              return null;
            }

            if (!isActiveUserState(result.user as typeof result.user & {
              status?: string | null;
              disabledAt?: Date | null;
              deletedAt?: Date | null;
            })) {
              try {
                await deleteSession?.(hashedSessionToken);
              } catch (error) {
                if (!hasPrismaErrorCode(error, "P2025")) {
                  throw error;
                }
              }

              return null;
            }

            return {
              user: result.user,
              session: restoreRawSessionToken(
                result.session,
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
            const persisted = await updateSession({
              ...session,
              sessionToken: hashSessionToken(rawSessionToken),
            });

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
