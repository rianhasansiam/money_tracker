import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";

const MAX_BOOTSTRAP_ATTEMPTS = 3;

const bootstrapAdminEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());

type BootstrapAdminResult =
  | {
      status: "created";
    }
  | {
      status: "promoted";
    }
  | {
      status: "canonicalized";
    }
  | {
      status: "activated";
    }
  | {
      status: "unchanged";
    };

export interface AdminBootstrapRepository {
  ensureAdmin(canonicalEmail: string): Promise<BootstrapAdminResult>;
}

export class BootstrapAdminConfigurationError extends Error {
  constructor() {
    super("BOOTSTRAP_ADMIN_EMAIL is missing or invalid.");
    this.name = "BootstrapAdminConfigurationError";
  }
}

class BootstrapAdminAmbiguousIdentityError extends Error {
  constructor() {
    super("More than one user matches the configured administrator identity.");
    this.name = "BootstrapAdminAmbiguousIdentityError";
  }
}

class BootstrapAdminInactiveIdentityError extends Error {
  constructor() {
    super("The configured administrator identity is disabled or deleted.");
    this.name = "BootstrapAdminInactiveIdentityError";
  }
}

class BootstrapAdminConflictError extends Error {
  constructor() {
    super("The administrator bootstrap conflicted with another database write.");
    this.name = "BootstrapAdminConflictError";
  }
}

export function parseBootstrapAdminEmail(value: string | undefined) {
  const parsedEmail = bootstrapAdminEmailSchema.safeParse(value);

  if (!parsedEmail.success) {
    throw new BootstrapAdminConfigurationError();
  }

  return parsedEmail.data;
}

export async function bootstrapAdmin(
  repository: AdminBootstrapRepository,
  configuredEmail: string | undefined,
) {
  const canonicalEmail = parseBootstrapAdminEmail(configuredEmail);

  return repository.ensureAdmin(canonicalEmail);
}

export function createPrismaAdminBootstrapRepository(
  database: Pick<PrismaClient, "$transaction">,
): AdminBootstrapRepository {
  return {
    async ensureAdmin(canonicalEmail) {
      for (let attempt = 0; attempt < MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        try {
          return await database.$transaction(
            async (tx) => {
              const matchingUsers = await tx.user.findMany({
                where: {
                  email: {
                    equals: canonicalEmail,
                    mode: "insensitive",
                  },
                },
                select: {
                  id: true,
                  email: true,
                  role: true,
                  status: true,
                  disabledAt: true,
                  deletedAt: true,
                },
                take: 2,
              });

              if (matchingUsers.length > 1) {
                throw new BootstrapAdminAmbiguousIdentityError();
              }

              const matchingUser = matchingUsers[0];

              if (matchingUser) {
                if (
                  matchingUser.disabledAt !== null ||
                  matchingUser.deletedAt !== null ||
                  matchingUser.status === "DISABLED" ||
                  matchingUser.status === "DELETED"
                ) {
                  throw new BootstrapAdminInactiveIdentityError();
                }

                const needsPromotion = matchingUser.role !== "ADMIN";
                const needsCanonicalEmail = matchingUser.email !== canonicalEmail;
                const needsActivation = matchingUser.status !== "ACTIVE";

                if (!needsPromotion && !needsCanonicalEmail && !needsActivation) {
                  return {
                    status: "unchanged",
                  };
                }

                await tx.user.update({
                  where: {
                    id: matchingUser.id,
                  },
                  data: {
                    email: canonicalEmail,
                    role: "ADMIN",
                    status: "ACTIVE",
                  },
                });

                return {
                  status: needsPromotion
                    ? "promoted"
                    : needsCanonicalEmail
                      ? "canonicalized"
                      : "activated",
                };
              }

              await tx.user.upsert({
                where: {
                  email: canonicalEmail,
                },
                create: {
                  email: canonicalEmail,
                  role: "ADMIN",
                  status: "ACTIVE",
                },
                update: {
                  role: "ADMIN",
                  status: "ACTIVE",
                },
              });

              return {
                status: "created",
              };
            },
            {
              isolationLevel: "Serializable",
            },
          );
        } catch (error) {
          if (
            error instanceof BootstrapAdminAmbiguousIdentityError ||
            error instanceof BootstrapAdminInactiveIdentityError
          ) {
            throw error;
          }

          if (
            hasPrismaErrorCode(error, "P2002") ||
            hasPrismaErrorCode(error, "P2034")
          ) {
            if (attempt === MAX_BOOTSTRAP_ATTEMPTS - 1) {
              throw new BootstrapAdminConflictError();
            }

            continue;
          }

          throw error;
        }
      }

      throw new BootstrapAdminConflictError();
    },
  };
}
