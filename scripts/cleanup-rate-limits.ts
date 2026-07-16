import "dotenv/config";
import { db } from "../src/lib/db";

async function main() {
  await db.rateLimitBucket.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });

  console.log("Expired rate-limit buckets cleaned.");
}

main()
  .catch(() => {
    console.error("Rate-limit cleanup failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
  });
