import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
  prismaSchemaSignature?: string;
};

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set.");
}

function getGeneratedSchemaSignature() {
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  try {
    const generatedSchema = readFileSync(
      path.join(process.cwd(), "node_modules", ".prisma", "client", "schema.prisma"),
      "utf8",
    );

    return createHash("sha1").update(generatedSchema).digest("hex");
  } catch {
    return "development";
  }
}

const adapter = new PrismaPg({
  connectionString,
});

const schemaSignature = getGeneratedSchemaSignature();
const shouldReusePrismaClient =
  globalForPrisma.prisma !== undefined &&
  globalForPrisma.prismaSchemaSignature === schemaSignature;

if (!shouldReusePrismaClient && globalForPrisma.prisma) {
  void globalForPrisma.prisma.$disconnect().catch(() => undefined);
}

export const db =
  globalForPrisma.prisma && shouldReusePrismaClient
    ? globalForPrisma.prisma
    : new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
      });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
  globalForPrisma.prismaSchemaSignature = schemaSignature;
}
