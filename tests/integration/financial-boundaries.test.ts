import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTransactionDateInput, toTransactionDateInputValue } from "@/lib/date-time";
import { parseMoneyToMinorUnits } from "@/lib/money";
import { transactionFormSchema } from "@/lib/validators/transaction";
import {
  POSTGRES_TEST_SKIP_REASON,
  type PostgresTestHarness,
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
} from "../helpers/postgres-test-harness";

describe("financial calendar boundaries in disposable PostgreSQL", () => {
  if (!isPostgresTestDatabaseConfigured()) {
    it.skip(POSTGRES_TEST_SKIP_REASON, () => undefined);
    return;
  }

  let harness: PostgresTestHarness;
  let transactions: typeof import("@/lib/data/transactions");
  let ownerId: string;
  let teamId: string;

  beforeAll(async () => {
    harness = await openPostgresTestHarness();
    await harness.clean();
    transactions = await import("@/lib/data/transactions");
    const owner = await harness.db.user.create({
      data: { name: "Calendar regression owner", role: "ADMIN", status: "ACTIVE" },
    });
    const team = await harness.db.team.create({
      data: { name: "Disposable calendar regression", createdById: owner.id },
    });
    await harness.db.teamMembership.create({
      data: {
        teamId: team.id,
        userId: owner.id,
        role: "ADMIN",
        status: "APPROVED",
        approvedAt: new Date(),
        approvedById: owner.id,
      },
    });
    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it.each(["0001-01-01", "0099-01-01", "0100-01-01", "2024-02-29"])(
    "preserves accepted date %s from validation through persistence and replay",
    async (transactionDate) => {
      const values = transactionFormSchema.parse({
        amount: "1.01",
        note: `Calendar regression ${transactionDate}`,
        type: "ADD",
        transactionDate,
      });
      const parsedDate = parseTransactionDateInput(values.transactionDate);
      const input = {
        teamId,
        idempotencyKey: randomUUID(),
        amountInCents: parseMoneyToMinorUnits(values.amount),
        note: values.note,
        type: values.type,
        transactionDate: parsedDate,
      };
      const saved = await transactions.createTeamTransaction(ownerId, input);
      const persisted = await harness.db.transaction.findUniqueOrThrow({
        where: { id: saved.transaction.id },
      });

      expect(persisted.transactionDate.toISOString()).toBe(
        `${transactionDate}T00:00:00.000Z`,
      );
      expect(toTransactionDateInputValue(persisted.transactionDate)).toBe(transactionDate);
      expect(parsedDate.toISOString()).toBe(`${transactionDate}T00:00:00.000Z`);
      await expect(
        transactions.createTeamTransaction(ownerId, input),
      ).resolves.toMatchObject({
        replayed: true,
        transaction: { id: saved.transaction.id },
      });
    },
  );
});
