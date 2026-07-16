import { describe, expect, it } from "vitest";
import {
  canCreateOrDeleteGroups,
  canManageTeamMembership,
  formatRoleLabel,
} from "@/lib/roles";
import { globalRoleInputSchema } from "@/lib/validators/admin";

describe("role and permission helpers", () => {
  it.each(["ADMIN", "MODERATOR"])(
    "allows the %s team role to manage transactions and memberships",
    (role) => {
      expect(canManageTeamMembership(role)).toBe(true);
    },
  );

  it.each(["MEMBER", "MODARETOR", "", null, undefined])(
    "does not grant team-management permission to %s",
    (role) => {
      expect(canManageTeamMembership(role)).toBe(false);
    },
  );

  it("reserves global group lifecycle operations for administrators", () => {
    expect(canCreateOrDeleteGroups("ADMIN")).toBe(true);
    expect(canCreateOrDeleteGroups("MODERATOR")).toBe(false);
    expect(canCreateOrDeleteGroups("MEMBER")).toBe(false);
  });

  it("formats the corrected moderator label", () => {
    expect(formatRoleLabel("ADMIN")).toBe("Admin");
    expect(formatRoleLabel("MODERATOR")).toBe("Moderator");
    expect(formatRoleLabel("MEMBER")).toBe("Member");
  });

  it("accepts only the corrected moderator value in admin input", () => {
    expect(
      globalRoleInputSchema.safeParse({
        email: "moderator@example.test",
        role: "MODERATOR",
      }).success,
    ).toBe(true);
    expect(
      globalRoleInputSchema.safeParse({
        email: "moderator@example.test",
        role: "MODARETOR",
      }).success,
    ).toBe(false);
  });
});
