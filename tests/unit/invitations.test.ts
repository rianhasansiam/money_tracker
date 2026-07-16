import { describe, expect, it, vi } from "vitest";
import type { InvitationRepository } from "@/lib/invitations";
import {
  InvitationValidationError,
  admitInvitedGoogleIdentity,
  provisionInvitation,
  revokeInvitation,
} from "@/lib/invitations";

function repository(): InvitationRepository {
  return {
    provision: vi.fn(async (input) => ({
      status: "created" as const,
      invitationId: "invitation-1",
      expiresAt: input.expiresAt,
    })),
    revoke: vi.fn(async () => ({
      status: "revoked" as const,
      invitationId: "invitation-1",
    })),
    admit: vi.fn(async () => true),
  };
}

describe("invitation admission boundary", () => {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const correlationId = "4f635d30-b641-4944-b66f-c3beac114f8a";

  it("canonicalizes an administrator-provisioned identity", async () => {
    const invitations = repository();

    await provisionInvitation(invitations, {
      actorUserId: "administrator-1",
      email: "  Invited.User@Example.COM ",
      now,
      expiresAt: new Date("2026-07-22T10:00:00.000Z"),
      correlationId,
    });

    expect(invitations.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "administrator-1",
        canonicalEmail: "invited.user@example.com",
        correlationId,
      }),
    );
  });

  it("rejects malformed and unreasonably short/long invitation requests", async () => {
    const invitations = repository();

    await expect(
      provisionInvitation(invitations, {
        actorUserId: "administrator-1",
        email: "invalid",
        now,
      }),
    ).rejects.toBeInstanceOf(InvitationValidationError);
    await expect(
      provisionInvitation(invitations, {
        actorUserId: "administrator-1",
        email: "invited@example.com",
        now,
        expiresAt: new Date("2026-07-15T10:01:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(InvitationValidationError);
    expect(invitations.provision).not.toHaveBeenCalled();
  });

  it("fails closed before repository access for an invalid Google identity", async () => {
    const invitations = repository();

    await expect(
      admitInvitedGoogleIdentity(invitations, "not-an-email", now),
    ).resolves.toBe(false);
    expect(invitations.admit).not.toHaveBeenCalled();
  });

  it("uses the same canonical identity for admission and revocation", async () => {
    const invitations = repository();

    await expect(
      admitInvitedGoogleIdentity(
        invitations,
        "Invited.User@Example.COM",
        now,
        correlationId,
      ),
    ).resolves.toBe(true);
    await revokeInvitation(invitations, {
      actorUserId: "administrator-1",
      email: "Invited.User@Example.COM",
      now,
      correlationId,
    });

    expect(invitations.admit).toHaveBeenCalledWith(
      "invited.user@example.com",
      now,
      correlationId,
    );
    expect(invitations.revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalEmail: "invited.user@example.com",
      }),
    );
  });
});
