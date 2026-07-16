import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";

const MAX_LIFECYCLE_ATTEMPTS = 3;

export type DisableUserResult =
  | {
      status: "disabled";
      disabledAt: Date;
      revokedSessionCount: number;
    }
  | {
      status: "not_found";
    };

export type SoftDeleteUserResult =
  | {
      status: "soft_deleted";
      deletedAt: Date;
      revokedSessionCount: number;
    }
  | {
      status: "not_found";
    }
  | {
      status: "ownership_transfer_required";
    };

export type HardDeleteUserResult =
  | {
      status: "deleted";
    }
  | {
      status: "not_found";
    }
  | {
      status: "ownership_transfer_required";
    };

export interface TransferTeamOwnershipInput {
  teamId: string;
  newOwnerId: string;
}

export interface TransferTeamOwnershipResult {
  teamId: string;
  previousOwnerId: string;
  newOwnerId: string;
  changed: boolean;
}

export class UnauthorizedOwnershipTransferError extends Error {
  constructor() {
    super("The requester cannot transfer ownership of this team.");
    this.name = "UnauthorizedOwnershipTransferError";
  }
}

export class InvalidOwnershipTargetError extends Error {
  constructor() {
    super("The new owner must be an active, approved team member.");
    this.name = "InvalidOwnershipTargetError";
  }
}

export class OwnershipTransferConflictError extends Error {
  constructor() {
    super("Team ownership changed concurrently.");
    this.name = "OwnershipTransferConflictError";
  }
}

export class UserLifecycleConflictError extends Error {
  constructor() {
    super("The user lifecycle operation conflicted with another database write.");
    this.name = "UserLifecycleConflictError";
  }
}

function assertValidLifecycleDate(value: Date) {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("A valid lifecycle timestamp is required.");
  }
}

async function runSerializableLifecycle<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < MAX_LIFECYCLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, "P2034")) {
        if (attempt === MAX_LIFECYCLE_ATTEMPTS - 1) {
          throw new UserLifecycleConflictError();
        }

        continue;
      }

      throw error;
    }
  }

  throw new UserLifecycleConflictError();
}

export async function revokeUserSessions(userId: string) {
  const result = await db.session.deleteMany({
    where: {
      userId,
    },
  });

  return result.count;
}

export async function disableUserAndRevokeSessions(
  userId: string,
  disabledAt = new Date(),
): Promise<DisableUserResult> {
  assertValidLifecycleDate(disabledAt);

  return runSerializableLifecycle(
    async (tx) => {
      const user = await tx.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          status: true,
          disabledAt: true,
          deletedAt: true,
        },
      });

      if (!user || user.status === "DELETED" || user.deletedAt !== null) {
        return {
          status: "not_found",
        };
      }

      const effectiveDisabledAt = user.disabledAt ?? disabledAt;

      if (user.status !== "DISABLED" || user.disabledAt === null) {
        await tx.user.update({
          where: {
            id: userId,
          },
          data: {
            status: "DISABLED",
            disabledAt: effectiveDisabledAt,
          },
        });
      }

      const revokedSessions = await tx.session.deleteMany({
        where: {
          userId,
        },
      });

      return {
        status: "disabled",
        disabledAt: effectiveDisabledAt,
        revokedSessionCount: revokedSessions.count,
      };
    },
  );
}

export async function softDeleteUserAndRevokeSessions(
  userId: string,
  deletedAt = new Date(),
): Promise<SoftDeleteUserResult> {
  assertValidLifecycleDate(deletedAt);

  return runSerializableLifecycle(
    async (tx) => {
      const user = await tx.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          status: true,
          disabledAt: true,
          deletedAt: true,
          _count: {
            select: {
              createdTeams: true,
            },
          },
        },
      });

      if (!user) {
        return {
          status: "not_found",
        };
      }

      if (user._count.createdTeams > 0) {
        return {
          status: "ownership_transfer_required",
        };
      }

      const effectiveDeletedAt = user.deletedAt ?? deletedAt;

      await tx.user.update({
        where: {
          id: userId,
        },
        data: {
          status: "DELETED",
          disabledAt: user.disabledAt ?? effectiveDeletedAt,
          deletedAt: effectiveDeletedAt,
        },
      });

      const revokedSessions = await tx.session.deleteMany({
        where: {
          userId,
        },
      });

      return {
        status: "soft_deleted",
        deletedAt: effectiveDeletedAt,
        revokedSessionCount: revokedSessions.count,
      };
    },
  );
}

export async function hardDeleteUser(
  userId: string,
): Promise<HardDeleteUserResult> {
  try {
    return await runSerializableLifecycle(async (tx) => {
      const user = await tx.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          _count: {
            select: {
              createdTeams: true,
            },
          },
        },
      });

      if (!user) {
        return {
          status: "not_found",
        };
      }

      if (user._count.createdTeams > 0) {
        return {
          status: "ownership_transfer_required",
        };
      }

      await tx.user.delete({
        where: {
          id: userId,
        },
      });

      return {
        status: "deleted",
      };
    });
  } catch (error) {
    if (hasPrismaErrorCode(error, "P2003")) {
      return {
        status: "ownership_transfer_required",
      };
    }

    if (hasPrismaErrorCode(error, "P2025")) {
      return {
        status: "not_found",
      };
    }

    throw error;
  }
}

export async function transferTeamOwnership(
  requesterId: string,
  input: TransferTeamOwnershipInput,
): Promise<TransferTeamOwnershipResult> {
  for (let attempt = 0; attempt < MAX_LIFECYCLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const requester = await tx.user.findUnique({
            where: {
              id: requesterId,
            },
            select: {
              role: true,
              status: true,
              disabledAt: true,
              deletedAt: true,
            },
          });
          const team = await tx.team.findUnique({
            where: {
              id: input.teamId,
            },
            select: {
              deletedAt: true,
              id: true,
              createdById: true,
            },
          });
          const target = await tx.user.findUnique({
            where: {
              id: input.newOwnerId,
            },
            select: {
              status: true,
              disabledAt: true,
              deletedAt: true,
              teamMemberships: {
                where: {
                  teamId: input.teamId,
                  status: "APPROVED",
                },
                select: {
                  id: true,
                  role: true,
                },
                take: 1,
              },
            },
          });

          if (
            !requester ||
            requester.status !== "ACTIVE" ||
            requester.disabledAt !== null ||
            requester.deletedAt !== null ||
            !team ||
            team.deletedAt !== null ||
            (requester.role !== "ADMIN" && team.createdById !== requesterId)
          ) {
            throw new UnauthorizedOwnershipTransferError();
          }

          const targetMembership = target?.teamMemberships[0];

          if (
            !target ||
            target.status !== "ACTIVE" ||
            target.disabledAt !== null ||
            target.deletedAt !== null ||
            !targetMembership
          ) {
            throw new InvalidOwnershipTargetError();
          }

          if (targetMembership.role !== "ADMIN") {
            const promoted = await tx.teamMembership.updateMany({
              where: {
                id: targetMembership.id,
                teamId: team.id,
                userId: input.newOwnerId,
                status: "APPROVED",
              },
              data: {
                role: "ADMIN",
              },
            });

            if (promoted.count !== 1) {
              throw new InvalidOwnershipTargetError();
            }
          }

          if (team.createdById === input.newOwnerId) {
            return {
              teamId: team.id,
              previousOwnerId: team.createdById,
              newOwnerId: input.newOwnerId,
              changed: false,
            };
          }

          const transferred = await tx.team.updateMany({
            where: {
              id: team.id,
              createdById: team.createdById,
            },
            data: {
              createdById: input.newOwnerId,
            },
          });

          if (transferred.count !== 1) {
            throw new OwnershipTransferConflictError();
          }

          return {
            teamId: team.id,
            previousOwnerId: team.createdById,
            newOwnerId: input.newOwnerId,
            changed: true,
          };
        },
        {
          isolationLevel: "Serializable",
        },
      );
    } catch (error) {
      if (
        error instanceof InvalidOwnershipTargetError ||
        error instanceof UnauthorizedOwnershipTransferError
      ) {
        throw error;
      }

      if (
        error instanceof OwnershipTransferConflictError ||
        hasPrismaErrorCode(error, "P2034")
      ) {
        if (attempt === MAX_LIFECYCLE_ATTEMPTS - 1) {
          throw new OwnershipTransferConflictError();
        }

        continue;
      }

      if (
        hasPrismaErrorCode(error, "P2003") ||
        hasPrismaErrorCode(error, "P2025")
      ) {
        throw new InvalidOwnershipTargetError();
      }

      throw error;
    }
  }

  throw new OwnershipTransferConflictError();
}
