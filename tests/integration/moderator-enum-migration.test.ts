import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  POSTGRES_TEST_SKIP_REASON,
  isPostgresTestDatabaseConfigured,
} from "../helpers/postgres-test-harness";
import {
  acquireTestDatabaseLease,
  assertDestructiveTestMode,
  validateTestDatabaseEnvironment,
} from "../helpers/test-database-safety";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "prisma",
  "migrations",
  "20260715150000_rename_moderator_enum_values",
  "migration.sql",
);

interface EnumIdentityRow {
  enumLabel: string;
  typeName: string;
  typeOid: string;
  valueOid: string;
}

interface LegacyRoleRow {
  id: string;
  role: string;
}

describe("moderator enum compatibility migration", () => {
  if (!isPostgresTestDatabaseConfigured()) {
    it.skip(POSTGRES_TEST_SKIP_REASON, () => undefined);
    return;
  }

  it(
    "renames both persisted legacy values without replacing rows or enum OIDs",
    async () => {
      assertDestructiveTestMode();
      const approvedDatabase = validateTestDatabaseEnvironment();
      const lease = await acquireTestDatabaseLease(approvedDatabase);
      const schemaName = `mt_enum_compat_${randomUUID().replaceAll("-", "")}`;
      const schemaIdentifier = `"${schemaName}"`;
      const client = new Client({
        connectionString: approvedDatabase.connectionString,
      });
      let connected = false;

      try {
        await client.connect();
        connected = true;
        const databaseResult = await client.query<{ databaseName: string }>(
          'SELECT current_database() AS "databaseName"',
        );

        expect(databaseResult.rows).toEqual([
          { databaseName: approvedDatabase.databaseName },
        ]);

        await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
        await client.query(`SET search_path TO ${schemaIdentifier}`);
        await client.query(`
          CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MODARETOR', 'MEMBER');
          CREATE TYPE "TeamMemberRole" AS ENUM ('ADMIN', 'MODARETOR', 'MEMBER');
          CREATE TABLE "LegacyUser" (
            "id" TEXT PRIMARY KEY,
            "role" "UserRole" NOT NULL
          );
          CREATE TABLE "LegacyTeamMembership" (
            "id" TEXT PRIMARY KEY,
            "role" "TeamMemberRole" NOT NULL
          );
          INSERT INTO "LegacyUser" ("id", "role")
          VALUES ('legacy-global-moderator', 'MODARETOR'), ('legacy-member', 'MEMBER');
          INSERT INTO "LegacyTeamMembership" ("id", "role")
          VALUES ('legacy-team-moderator', 'MODARETOR'), ('legacy-team-member', 'MEMBER');
        `);

        const beforeResult = await client.query<EnumIdentityRow>(`
          SELECT
            enum_value.enumlabel AS "enumLabel",
            enum_type.typname AS "typeName",
            enum_type.oid::TEXT AS "typeOid",
            enum_value.oid::TEXT AS "valueOid"
          FROM pg_enum AS enum_value
          INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
          INNER JOIN pg_namespace AS enum_schema ON enum_schema.oid = enum_type.typnamespace
          WHERE enum_schema.nspname = '${schemaName}'
            AND enum_type.typname IN ('UserRole', 'TeamMemberRole')
            AND enum_value.enumlabel = 'MODARETOR'
          ORDER BY enum_type.typname
        `);

        expect(beforeResult.rows).toHaveLength(2);

        const migrationSql = await readFile(MIGRATION_PATH, "utf8");
        await client.query(migrationSql);

        const afterResult = await client.query<EnumIdentityRow>(`
          SELECT
            enum_value.enumlabel AS "enumLabel",
            enum_type.typname AS "typeName",
            enum_type.oid::TEXT AS "typeOid",
            enum_value.oid::TEXT AS "valueOid"
          FROM pg_enum AS enum_value
          INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
          INNER JOIN pg_namespace AS enum_schema ON enum_schema.oid = enum_type.typnamespace
          WHERE enum_schema.nspname = '${schemaName}'
            AND enum_type.typname IN ('UserRole', 'TeamMemberRole')
            AND enum_value.enumlabel = 'MODERATOR'
          ORDER BY enum_type.typname
        `);

        expect(afterResult.rows).toEqual(
          beforeResult.rows.map((row) => ({
            ...row,
            enumLabel: "MODERATOR",
          })),
        );

        const globalRoles = await client.query<LegacyRoleRow>(`
          SELECT "id", "role"::TEXT AS "role"
          FROM "LegacyUser"
          ORDER BY "id"
        `);
        const teamRoles = await client.query<LegacyRoleRow>(`
          SELECT "id", "role"::TEXT AS "role"
          FROM "LegacyTeamMembership"
          ORDER BY "id"
        `);

        expect(globalRoles.rows).toEqual([
          { id: "legacy-global-moderator", role: "MODERATOR" },
          { id: "legacy-member", role: "MEMBER" },
        ]);
        expect(teamRoles.rows).toEqual([
          { id: "legacy-team-member", role: "MEMBER" },
          { id: "legacy-team-moderator", role: "MODERATOR" },
        ]);

        await client.query(migrationSql);
        await expect(
          client.query<{ legacyLabelCount: number }>(`
            SELECT COUNT(*)::INTEGER AS "legacyLabelCount"
            FROM pg_enum AS enum_value
            INNER JOIN pg_type AS enum_type ON enum_type.oid = enum_value.enumtypid
            INNER JOIN pg_namespace AS enum_schema ON enum_schema.oid = enum_type.typnamespace
            WHERE enum_schema.nspname = '${schemaName}'
              AND enum_value.enumlabel = 'MODARETOR'
          `),
        ).resolves.toMatchObject({
          rows: [{ legacyLabelCount: 0 }],
        });
      } finally {
        try {
          if (connected) {
            await client.query("ROLLBACK").catch(() => undefined);
            await client.query("RESET search_path").catch(() => undefined);
            try {
              await client.query(
                `DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`,
              );
            } finally {
              await client.end();
            }
          }
        } finally {
          await lease.release();
        }
      }
    },
    30_000,
  );
});
