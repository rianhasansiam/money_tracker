import { describe, expect, it, vi } from "vitest";
import type { AuditEventDatabase } from "@/lib/audit-events";
import {
  InvalidAuditEventError,
  recordAuditEvent,
} from "@/lib/audit-events";

function auditDatabase() {
  const create = vi.fn(async () => ({
    id: "audit-event",
    createdAt: new Date("2026-07-15T10:00:00.000Z"),
  }));

  return {
    create,
    database: {
      auditEvent: {
        create,
      },
    } as unknown as AuditEventDatabase,
  };
}

describe("append-only audit event writer", () => {
  it("writes bounded snapshots without requiring live user/team relations", async () => {
    const { create, database } = auditDatabase();

    await recordAuditEvent(database, {
      action: "team.quarantined",
      actorUserId: "actor-1",
      actorIdSnapshot: "actor-1",
      actorNameSnapshot: "Administrator",
      targetType: "team",
      targetIdSnapshot: "team-1",
      teamIdSnapshot: "team-1",
      correlationId: "4f635d30-b641-4944-b66f-c3beac114f8a",
      metadata: {
        retentionDays: 30,
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorIdSnapshot: "actor-1",
          targetIdSnapshot: "team-1",
          metadata: { retentionDays: 30 },
        }),
      }),
    );
  });

  it.each([
    { email: "person@example.test" },
    { accessToken: "bearer-value" },
    { note: "private ledger text" },
  ])("rejects sensitive metadata before database access", async (metadata) => {
    const { create, database } = auditDatabase();

    await expect(
      recordAuditEvent(database, {
        action: "security.test",
        actorIdSnapshot: "system",
        actorNameSnapshot: "System",
        targetType: "system",
        targetIdSnapshot: "security-policy",
        correlationId: "4f635d30-b641-4944-b66f-c3beac114f8a",
        metadata,
      }),
    ).rejects.toBeInstanceOf(InvalidAuditEventError);
    expect(create).not.toHaveBeenCalled();
  });
});
