import { z } from "zod";
import { teamIdSchema } from "@/lib/validators/team";

const normalizedEmailSchema = z
  .string()
  .trim()
  .min(1, "Enter an email address.")
  .max(254, "The email address is too long.")
  .email("Enter a valid email address.")
  .transform((email) => email.toLowerCase());

export const teamLifecycleInputSchema = z.object({
  teamId: teamIdSchema,
  confirmedTeamName: z
    .string()
    .trim()
    .min(1, "Type the team name to confirm.")
    .max(80, "The team name is too long."),
});

export const invitationInputSchema = z.object({
  email: normalizedEmailSchema,
  expiresInDays: z.coerce
    .number()
    .int()
    .min(1, "Invitations must remain valid for at least one day.")
    .max(30, "Invitations cannot remain valid for more than 30 days."),
});

export const userLifecycleInputSchema = z.object({
  email: normalizedEmailSchema,
});

export const globalRoleInputSchema = z.object({
  email: normalizedEmailSchema,
  role: z.enum(["ADMIN", "MODERATOR", "MEMBER"]),
});

export const membershipRevocationInputSchema = z.object({
  teamId: teamIdSchema,
  email: normalizedEmailSchema,
});

export const ownershipTransferInputSchema = z.object({
  teamId: teamIdSchema,
  newOwnerEmail: normalizedEmailSchema,
  confirmedTeamName: z
    .string()
    .trim()
    .min(1, "Type the team name to confirm.")
    .max(80, "The team name is too long."),
});
