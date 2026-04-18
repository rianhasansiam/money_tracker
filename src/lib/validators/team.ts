import type { ZodError } from "zod";
import { z } from "zod";

export const teamIdSchema = z.string().cuid("Invalid team.");
export const membershipIdSchema = z.string().cuid("Invalid membership request.");

export const createTeamFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Team name must be at least 3 characters.")
    .max(80, "Team name must be 80 characters or fewer."),
  description: z
    .string()
    .trim()
    .max(240, "Keep the description to 240 characters or fewer."),
});

export type CreateTeamFormValues = z.infer<typeof createTeamFormSchema>;

export function getCreateTeamFormDefaults(): CreateTeamFormValues {
  return {
    name: "",
    description: "",
  };
}

export function flattenCreateTeamErrors(error: ZodError<CreateTeamFormValues>) {
  const flattened = error.flatten().fieldErrors;

  return Object.fromEntries(
    Object.entries(flattened).map(([key, value]) => [key, value?.[0]]),
  ) as Partial<Record<keyof CreateTeamFormValues, string>>;
}
