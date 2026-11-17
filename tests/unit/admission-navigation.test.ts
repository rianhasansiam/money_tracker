import { describe, expect, it } from "vitest";
import { adminSearchFields, adminViewHref, readAdminNavigation, resetAdminViewPage } from "@/lib/admin-navigation";
import { safeAuthenticationReturn, reauthenticationLocation } from "@/lib/auth-return";
import { canonicalSignInUrl, invitationAccessInstructions } from "@/lib/access-instructions";

describe("task-scoped administrative navigation", () => {
  it("retains each task's search/page while switching and resets only the searched task", () => {
    const state = readAdminNavigation({ view: "access", accountsQ: "person", userCursor: "user@example.test", accessQ: "Treasury", teamCursor: "clh1234567890abcdefghijk", memberTeamId: "clh1234567890abcdefghijk", memberCursor: "member@example.test", recoveryQ: "Old team" });
    const href = adminViewHref(state, "accounts");
    expect(href).toContain("view=accounts");
    expect(href).toContain("accessQ=Treasury");
    expect(href).toContain("userCursor=user%40example.test");
    const reset = resetAdminViewPage(state, "Another team");
    expect(reset.cursors.accounts).toBe(state.cursors.accounts);
    expect(reset.cursors.access).toBeUndefined();
    expect(reset.memberCursor).toBeUndefined();
    expect(adminSearchFields(state).hidden.some(([key]) => key === "teamCursor")).toBe(false);
  });
  it("supports legacy q only for the selected task and bounds untrusted query values", () => {
    const state = readAdminNavigation({ view: "invitations", q: " invite@example.test ", accountsQ: "x".repeat(300) });
    expect(state.queries.invitations).toBe("invite@example.test");
    expect(state.queries.accounts).toHaveLength(254);
    expect(state.queries.access).toBe("");
  });
});

describe("safe reauthentication locations", () => {
  it.each(["https://attacker.invalid", "//attacker.invalid", "/\\attacker.invalid", "/admin\n", "/admin#draft", "/api/auth/signout", "/admin/other"])("rejects %s", (value) => expect(safeAuthenticationReturn(value)).toBe("/groups"));
  it("retains supported task navigation but cannot carry an action or draft", () => {
    const result = safeAuthenticationReturn("/admin?view=recovery&recoveryQ=Treasury&operation=purge&draft=private");
    expect(result).toBe("/admin?view=recovery&recoveryQ=Treasury");
    expect(reauthenticationLocation(result)).toContain("reauth=1&returnTo=");
  });
});

describe("shareable invitation instructions", () => {
  it("uses configured origins and validated platform environment, never request headers", () => {
    expect(canonicalSignInUrl({ NODE_ENV: "production", AUTH_URL: "https://ledger.example.test" })).toBe("https://ledger.example.test/login");
    expect(canonicalSignInUrl({ NODE_ENV: "production", VERCEL: "1", VERCEL_URL: "ledger.vercel.app" })).toBe("https://ledger.vercel.app/login");
    expect(canonicalSignInUrl({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "preview.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "ledger.example.test" })).toBe("https://preview.vercel.app/login");
    expect(canonicalSignInUrl({ NODE_ENV: "production", VERCEL: "1", VERCEL_URL: "attacker.invalid/path" })).toBeNull();
    expect(canonicalSignInUrl({ NODE_ENV: "production", VERCEL: "1" })).toBeNull();
    expect(canonicalSignInUrl({ NODE_ENV: "production", AUTH_URL: "http://external.invalid" })).toBeNull();
  });
  it("includes actual identity, expiry, separate team approval and no email claim", () => {
    const text = invitationAccessInstructions({ email: "invited@example.test", expiresAt: "2026-11-24T10:30:00Z", signInUrl: "https://ledger.example.test/login" });
    expect(text).toContain("invited@example.test");
    expect(text).toContain("https://ledger.example.test/login");
    expect(text).toContain("Nov 24, 2026");
    expect(text).toContain("Admin or Moderator");
    expect(text).toContain("No email has been sent");
  });
});
