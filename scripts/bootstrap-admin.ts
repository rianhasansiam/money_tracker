import "dotenv/config";
import {
  bootstrapAdmin,
  createPrismaAdminBootstrapRepository,
  parseBootstrapAdminEmail,
} from "../src/lib/admin-bootstrap";

async function main() {
  const configuredEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;

  // Validate before importing the database module so a missing administrator
  // identity fails without opening a connection or evaluating database config.
  parseBootstrapAdminEmail(configuredEmail);

  const { db } = await import("../src/lib/db");

  try {
    const repository = createPrismaAdminBootstrapRepository(db);
    await bootstrapAdmin(repository, configuredEmail);
    console.info("Administrator bootstrap completed successfully.");
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "Administrator bootstrap failed. Verify configuration and database readiness.",
  );
  process.exitCode = 1;
});
