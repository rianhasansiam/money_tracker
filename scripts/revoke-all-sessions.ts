import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { recordAuditEvent } from "../src/lib/audit-events";

const REQUIRED_CONFIRMATION = "REVOKE ALL APPLICATION SESSIONS";

function requiredValue(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error("Incident-response configuration is incomplete.");
  }

  return value;
}

async function main() {
  if (requiredValue("INCIDENT_CONFIRMATION") !== REQUIRED_CONFIRMATION) {
    throw new Error("Incident-response confirmation is invalid.");
  }

  const canonicalEmail = requiredValue("INCIDENT_ADMIN_EMAIL").toLowerCase();
  const correlationId = randomUUID();

  await db.$transaction(async (tx) => {
    const administrators = await tx.user.findMany({
      where: {
        email: {
          equals: canonicalEmail,
          mode: "insensitive",
        },
        role: "ADMIN",
        status: "ACTIVE",
        disabledAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
      },
      take: 2,
    });

    if (administrators.length !== 1) {
      throw new Error("Incident-response authorization failed.");
    }

    const actor = administrators[0];
    await tx.session.deleteMany();
    await recordAuditEvent(tx, {
      action: "SESSION_GLOBAL_REVOCATION",
      actorUserId: actor.id,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: actor.name?.trim().slice(0, 160) || "Administrator",
      targetType: "SESSION_SET",
      targetIdSnapshot: "all",
      correlationId,
      metadata: {
        outcome: "revoked",
      },
    });
  });

  console.log("All application sessions revoked; audit event retained.");
}

main()
  .catch(() => {
    console.error(
      "Global session revocation failed. Verify confirmation and administrator authorization.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
  });
