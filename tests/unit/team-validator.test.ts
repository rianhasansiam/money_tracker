import { describe, expect, it } from "vitest";
import { TEAM_ID_MAX_LENGTH, teamIdSchema } from "@/lib/validators/team";

describe("teamIdSchema", () => {
  it("accepts a Prisma cuid", () => {
    expect(teamIdSchema.safeParse("clh1234567890abcdefghijk").success).toBe(
      true,
    );
  });

  it.each(["", "not-a-cuid", " ckh12345678", "ckh12345678 "])(
    "rejects malformed identifier %s",
    (teamId) => {
      expect(teamIdSchema.safeParse(teamId).success).toBe(false);
    },
  );

  it("rejects oversized identifiers before database access", () => {
    expect(teamIdSchema.safeParse(`c${"x".repeat(TEAM_ID_MAX_LENGTH)}`).success).toBe(
      false,
    );
  });
});
