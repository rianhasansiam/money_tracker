import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { purgeTeamAfterRetention } from "../src/lib/team-lifecycle";

const REQUIRED_CONFIRMATION = "PERMANENTLY PURGE TEAM";

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error("Permanent purge configuration is incomplete.");
  }

  return value;
}

async function main() {
  const confirmation = requiredEnvironmentValue("PURGE_CONFIRMATION");

  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error("Permanent purge confirmation is invalid.");
  }

  const result = await purgeTeamAfterRetention({
    actorEmail: requiredEnvironmentValue("PURGE_ADMIN_EMAIL"),
    teamId: requiredEnvironmentValue("PURGE_TEAM_ID"),
    confirmedTeamName: requiredEnvironmentValue("PURGE_TEAM_NAME"),
    backupReference: requiredEnvironmentValue("PURGE_BACKUP_REFERENCE"),
    correlationId: randomUUID(),
  });

  if (result.status !== "purged") {
    throw new Error("The quarantined team is not eligible for permanent purge.");
  }

  console.log("Eligible quarantined team permanently purged; audit retained.");
}

main()
  .catch(() => {
    console.error(
      "Permanent purge failed. Verify authorization, retention, confirmation, and backup evidence.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
  });
