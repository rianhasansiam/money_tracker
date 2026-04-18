"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canCreateOrDeleteGroups, canManageTeamMembership } from "@/lib/roles";
import {
  createTeamFormSchema,
  membershipIdSchema,
  teamIdSchema,
  type CreateTeamFormValues,
  flattenCreateTeamErrors,
} from "@/lib/validators/team";

export type GroupActionResult =
  | {
      status: "success";
      message: string;
      teamId?: string;
    }
  | {
      status: "error";
      message: string;
      fieldErrors?: Partial<Record<keyof CreateTeamFormValues, string>>;
    };

function revalidateTeamViews(teamId?: string) {
  revalidatePath("/groups");
  revalidatePath("/dashboard");

  if (teamId) {
    revalidatePath(`/dashboard/${teamId}`);
  }
}

function isGlobalAdmin(
  session: { user?: { role?: string | null } | null } | null | undefined,
) {
  return canCreateOrDeleteGroups(session?.user?.role);
}

function hasPrismaErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function createTeam(
  input: CreateTeamFormValues,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  if (!isGlobalAdmin(session)) {
    return {
      status: "error",
      message: "Only admins can create groups. Modaretors cannot create groups.",
    };
  }

  const parsedInput = createTeamFormSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: flattenCreateTeamErrors(parsedInput.error),
    };
  }

  try {
    const team = await db.$transaction(async (tx) => {
      const createdTeam = await tx.team.create({
        data: {
          name: parsedInput.data.name,
          description: parsedInput.data.description || null,
          createdById: session.user.id,
        },
      });

      await tx.teamMembership.create({
        data: {
          teamId: createdTeam.id,
          userId: session.user.id,
          role: "ADMIN",
          status: "APPROVED",
          approvedAt: new Date(),
          approvedById: session.user.id,
        },
      });

      return createdTeam;
    });

    revalidateTeamViews(team.id);

    return {
      status: "success",
      message: "Team created. You are now the admin for this group.",
      teamId: team.id,
    };
  } catch (error) {
    if (hasPrismaErrorCode(error, "P2002")) {
      return {
        status: "error",
        message: "A team with this name already exists. Choose another name.",
        fieldErrors: {
          name: "A team with this name already exists.",
        },
      };
    }

    return {
      status: "error",
      message: "We could not create the team right now. Please try again.",
    };
  }
}

export async function deleteTeam(teamId: string): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  if (!isGlobalAdmin(session)) {
    return {
      status: "error",
      message: "Only admins can delete groups. Modaretors cannot delete groups.",
    };
  }

  const parsedTeamId = teamIdSchema.safeParse(teamId);

  if (!parsedTeamId.success) {
    return {
      status: "error",
      message: "This group is invalid.",
    };
  }

  const team = await db.team.findUnique({
    where: {
      id: parsedTeamId.data,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!team) {
    return {
      status: "error",
      message: "That group no longer exists.",
    };
  }

  await db.team.delete({
    where: {
      id: team.id,
    },
  });

  revalidateTeamViews(team.id);

  return {
    status: "success",
    message: `${team.name} was deleted successfully.`,
  };
}

export async function requestTeamAccess(teamId: string): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedTeamId = teamIdSchema.safeParse(teamId);

  if (!parsedTeamId.success) {
    return {
      status: "error",
      message: "This team request is invalid.",
    };
  }

  const team = await db.team.findUnique({
    where: {
      id: parsedTeamId.data,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!team) {
    return {
      status: "error",
      message: "That team no longer exists.",
    };
  }

  const existingMembership = await db.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId: team.id,
        userId: session.user.id,
      },
    },
    select: {
      status: true,
    },
  });

  if (existingMembership?.status === "APPROVED") {
    return {
      status: "error",
      message: `You are already a member of ${team.name}.`,
    };
  }

  if (existingMembership?.status === "PENDING") {
    return {
      status: "error",
      message: `Your join request for ${team.name} is already pending.`,
    };
  }

  await db.teamMembership.create({
    data: {
      teamId: team.id,
      userId: session.user.id,
      role: "MEMBER",
      status: "PENDING",
    },
  });

  revalidateTeamViews(team.id);

  return {
    status: "success",
    message: `Join request sent to ${team.name}.`,
  };
}

export async function approveTeamAccess(
  membershipId: string,
): Promise<GroupActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "error",
      message: "Your session has expired. Please sign in again.",
    };
  }

  const parsedMembershipId = membershipIdSchema.safeParse(membershipId);

  if (!parsedMembershipId.success) {
    return {
      status: "error",
      message: "This membership request is invalid.",
    };
  }

  const pendingMembership = await db.teamMembership.findUnique({
    where: {
      id: parsedMembershipId.data,
    },
    select: {
      id: true,
      status: true,
      teamId: true,
      user: {
        select: {
          name: true,
          email: true,
        },
      },
      team: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!pendingMembership || pendingMembership.status !== "PENDING") {
    return {
      status: "error",
      message: "That join request is no longer pending.",
    };
  }

  const approverMembership = await db.teamMembership.findUnique({
    where: {
      teamId_userId: {
        teamId: pendingMembership.teamId,
        userId: session.user.id,
      },
    },
    select: {
      role: true,
      status: true,
    },
  });

  if (
    !approverMembership ||
    approverMembership.status !== "APPROVED" ||
    !canManageTeamMembership(approverMembership.role)
  ) {
    return {
      status: "error",
      message: "Only approved team admins or modaretors can accept join requests.",
    };
  }

  await db.teamMembership.update({
    where: {
      id: pendingMembership.id,
    },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      approvedById: session.user.id,
    },
  });

  revalidateTeamViews(pendingMembership.teamId);

  const requesterLabel =
    pendingMembership.user.name || pendingMembership.user.email || "This member";

  return {
    status: "success",
    message: `${requesterLabel} can now view ${pendingMembership.team.name}.`,
  };
}
