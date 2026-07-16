import { randomUUID } from "node:crypto";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { GroupActionResult } from "@/actions/groups";
import type { CreateTeamTransactionInput } from "@/lib/data/transactions";
import {
  hardenAuthAdapter,
  hashSessionToken,
} from "@/lib/auth-adapter";
import {
  type AppDatabase,
  POSTGRES_TEST_SKIP_REASON,
  type PostgresTestHarness,
  isPostgresTestDatabaseConfigured,
  openPostgresTestHarness,
} from "../helpers/postgres-test-harness";
import {
  acquireTestDatabaseLease,
  type ApprovedTestDatabase,
  validateTestDatabaseEnvironment,
} from "../helpers/test-database-safety";

interface MockSession {
  user: {
    id: string;
    role?: "ADMIN" | "MODERATOR" | "MEMBER";
  };
}

const actionMocks = vi.hoisted(() => ({
  auth: vi.fn<() => Promise<MockSession | null>>(),
  refresh: vi.fn<() => void>(),
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("@/lib/auth", () => ({
  auth: actionMocks.auth,
}));

vi.mock("next/cache", () => ({
  refresh: actionMocks.refresh,
  revalidatePath: actionMocks.revalidatePath,
}));

type TransactionDataModule = typeof import("@/lib/data/transactions");
type TransactionActionModule = typeof import("@/actions/transactions");
type GroupActionModule = typeof import("@/actions/groups");
type AdminWorkflowsModule = typeof import("@/lib/admin-workflows");
type DashboardModule = typeof import("@/lib/queries/dashboard");
type GroupsQueryModule = typeof import("@/lib/queries/groups");
type RateLimitModule = typeof import("@/lib/rate-limit");
type TeamLifecycleModule = typeof import("@/lib/team-lifecycle");
type UserLifecycleModule = typeof import("@/lib/user-lifecycle");
type InvitationsModule = typeof import("@/lib/invitations");

const GROUP_ACTION_UNAVAILABLE_MESSAGE =
  "This group request cannot be processed. Refresh the page and try again.";
const TRANSACTION_DATE = new Date("2026-07-14T00:00:00.000Z");

describe("disposable PostgreSQL financial-integrity integration", () => {
  if (!isPostgresTestDatabaseConfigured()) {
    it.skip(POSTGRES_TEST_SKIP_REASON, () => undefined);
    return;
  }

  let harness: PostgresTestHarness | undefined;
  let db: AppDatabase;
  let transactionData: TransactionDataModule;
  let transactionActions: TransactionActionModule;
  let groupActions: GroupActionModule;
  let adminWorkflows: AdminWorkflowsModule;
  let dashboard: DashboardModule;
  let groupsQuery: GroupsQueryModule;
  let rateLimit: RateLimitModule;
  let teamLifecycle: TeamLifecycleModule;
  let userLifecycle: UserLifecycleModule;
  let invitations: InvitationsModule;
  let approvedDatabase: ApprovedTestDatabase;
  let previousRateLimitHashSecret: string | undefined;

  beforeAll(async () => {
    previousRateLimitHashSecret = process.env.RATE_LIMIT_HASH_SECRET;
    process.env.RATE_LIMIT_HASH_SECRET =
      "disposable-postgres-rate-limit-test-secret";
    approvedDatabase = validateTestDatabaseEnvironment();
    harness = await openPostgresTestHarness();
    db = harness.db;
    await harness.clean();

    [
      transactionData,
      transactionActions,
      groupActions,
      adminWorkflows,
      dashboard,
      groupsQuery,
      rateLimit,
      teamLifecycle,
      userLifecycle,
      invitations,
    ] = await Promise.all([
        import("@/lib/data/transactions"),
        import("@/actions/transactions"),
        import("@/actions/groups"),
        import("@/lib/admin-workflows"),
        import("@/lib/queries/dashboard"),
        import("@/lib/queries/groups"),
        import("@/lib/rate-limit"),
        import("@/lib/team-lifecycle"),
        import("@/lib/user-lifecycle"),
        import("@/lib/invitations"),
      ]);
  }, 30_000);

  beforeEach(async () => {
    await harness?.clean();
    actionMocks.auth.mockReset();
    actionMocks.refresh.mockReset();
    actionMocks.revalidatePath.mockReset();
    actionMocks.auth.mockResolvedValue(null);
  });

  afterEach(async () => {
    await harness?.clean();
  });

  afterAll(async () => {
    try {
      await harness?.close();
    } finally {
      if (previousRateLimitHashSecret === undefined) {
        delete process.env.RATE_LIMIT_HASH_SECRET;
      } else {
        process.env.RATE_LIMIT_HASH_SECRET = previousRateLimitHashSecret;
      }
    }
  }, 30_000);

  async function createManagedTeam() {
    const owner = await db.user.create({
      data: {
        name: "Synthetic owner",
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const team = await db.team.create({
      data: {
        name: "Disposable test ledger",
        description: "Synthetic integration fixture",
        createdById: owner.id,
      },
    });

    await db.teamMembership.create({
      data: {
        teamId: team.id,
        userId: owner.id,
        role: "ADMIN",
        status: "APPROVED",
        approvedAt: new Date("2026-07-14T00:00:00.000Z"),
        approvedById: owner.id,
      },
    });

    return { owner, team };
  }

  async function createTeamLifecycleFixture(now: Date) {
    const { owner: createdOwner, team } = await createManagedTeam();
    const owner = await db.user.update({
      where: { id: createdOwner.id },
      data: {
        email: "lifecycle.administrator@example.test",
        lastAuthenticatedAt: now,
      },
    });
    const { membership, user: member } = await createApprovedMember(
      team.id,
      owner.id,
      "MEMBER",
      "Synthetic retained member",
    );
    const ledgerWrite = await transactionData.createTeamTransaction(
      owner.id,
      transactionInput(team.id, randomUUID()),
    );

    return {
      ledgerWrite,
      member,
      membership,
      owner,
      team,
    };
  }

  async function createApprovedMember(
    teamId: string,
    approvedById: string,
    role: "ADMIN" | "MODERATOR" | "MEMBER" = "MEMBER",
    name = "Synthetic member",
  ) {
    const user = await db.user.create({
      data: {
        name,
        role: "MEMBER",
        status: "ACTIVE",
      },
    });

    const membership = await db.teamMembership.create({
      data: {
        teamId,
        userId: user.id,
        role,
        status: "APPROVED",
        approvedAt: new Date("2026-07-14T00:00:00.000Z"),
        approvedById,
      },
    });

    return { membership, user };
  }

  async function createPendingMember(teamId: string) {
    const user = await db.user.create({
      data: {
        name: "Synthetic requester",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const membership = await db.teamMembership.create({
      data: {
        teamId,
        userId: user.id,
        role: "MEMBER",
        status: "PENDING",
      },
    });

    return { membership, user };
  }

  function transactionInput(
    teamId: string,
    idempotencyKey: string,
    overrides: Partial<CreateTeamTransactionInput> = {},
  ): CreateTeamTransactionInput {
    return {
      teamId,
      idempotencyKey,
      amountInCents: 12_500,
      note: "Synthetic ledger entry",
      type: "ADD",
      transactionDate: TRANSACTION_DATE,
      ...overrides,
    };
  }

  function authenticateAs(userId: string) {
    actionMocks.auth.mockResolvedValue({
      user: {
        id: userId,
      },
    });
  }

  async function createSyntheticSessions(userId: string, count: number) {
    await db.session.createMany({
      data: Array.from({ length: count }, () => ({
        sessionToken: hashSessionToken(
          `synthetic-admin-workflow-${randomUUID()}`,
        ),
        userId,
        expires: new Date("2027-01-01T00:00:00.000Z"),
      })),
    });
  }

  async function expectConcurrentIdempotentWrite(callCount: number) {
    const { owner, team } = await createManagedTeam();
    const input = transactionInput(team.id, randomUUID());
    const results = await Promise.all(
      Array.from({ length: callCount }, () =>
        transactionData.createTeamTransaction(owner.id, { ...input }),
      ),
    );
    const savedRows = await db.transaction.findMany({
      where: {
        teamId: team.id,
        idempotencyKey: input.idempotencyKey,
      },
    });

    expect(savedRows).toHaveLength(1);
    expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(
      callCount - 1,
    );
  }

  async function runActionStartedBeforeLockedMutation<T>(
    action: () => Promise<T>,
    mutation: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<T> {
    let actionPromise: Promise<T> | undefined;

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        LOCK TABLE "Team", "TeamMembership" IN ACCESS EXCLUSIVE MODE
      `;
      actionPromise = action();
      await mutation(tx);
    });

    if (!actionPromise) {
      throw new Error("Synthetic concurrency fixture failed to start.");
    }

    return actionPromise;
  }

  function expectUnavailableGroupResult(result: GroupActionResult) {
    expect(result).toEqual({
      status: "error",
      message: GROUP_ACTION_UNAVAILABLE_MESSAGE,
    });
  }

  it.each([
    ["double-click submission", 2],
    ["duplicate browser tabs", 2],
    ["simultaneous identical submissions", 4],
  ])("stores one transaction for %s", async (_scenario, callCount) => {
    await expectConcurrentIdempotentWrite(callCount);
  });

  it("rejects a second destructive process while this suite holds the database lease", async () => {
    await expect(acquireTestDatabaseLease(approvedDatabase)).rejects.toThrow(
      /another test process already holds the database cleanup lease/,
    );
  });

  it("replays one committed result after the original response is lost", async () => {
    const { owner, team } = await createManagedTeam();
    const input = transactionInput(team.id, randomUUID());

    const committed = await transactionData.createTeamTransaction(owner.id, input);
    const replay = await transactionData.createTeamTransaction(owner.id, {
      ...input,
    });

    expect(committed.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      transaction: {
        id: committed.transaction.id,
      },
    });
    await expect(
      db.transaction.count({
        where: {
          teamId: team.id,
          idempotencyKey: input.idempotencyKey,
        },
      }),
    ).resolves.toBe(1);
  });

  it("replays safely after cache revalidation fails after commit", async () => {
    const { owner, team } = await createManagedTeam();
    const operationKey = randomUUID();
    authenticateAs(owner.id);
    actionMocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("Synthetic cache failure");
    });

    const firstResult = await transactionActions.createTransaction(
      team.id,
      operationKey,
      {
        amount: "125.00",
        note: "Synthetic ledger entry",
        transactionDate: "2026-07-14",
        type: "ADD",
      },
    );
    const retryResult = await transactionActions.createTransaction(
      team.id,
      operationKey,
      {
        amount: "125.00",
        note: "Synthetic ledger entry",
        transactionDate: "2026-07-14",
        type: "ADD",
      },
    );

    expect(firstResult).toMatchObject({
      status: "success",
      replayed: false,
      viewsUpdated: false,
    });
    expect(retryResult).toMatchObject({
      status: "success",
      replayed: true,
      viewsUpdated: true,
    });

    if (firstResult.status !== "success" || retryResult.status !== "success") {
      throw new Error("Synthetic transaction action fixture failed.");
    }

    expect(retryResult.transactionId).toBe(firstResult.transactionId);
    await expect(
      db.transaction.count({ where: { teamId: team.id, idempotencyKey: operationKey } }),
    ).resolves.toBe(1);
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const { owner, team } = await createManagedTeam();
    const input = transactionInput(team.id, randomUUID());

    const original = await transactionData.createTeamTransaction(owner.id, input);

    await expect(
      transactionData.createTeamTransaction(owner.id, {
        ...input,
        amountInCents: input.amountInCents + 1,
      }),
    ).rejects.toBeInstanceOf(transactionData.IdempotencyConflictError);

    const savedRows = await db.transaction.findMany({
      where: {
        teamId: team.id,
        idempotencyKey: input.idempotencyKey,
      },
    });
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]).toMatchObject({
      id: original.transaction.id,
      amountInCents: input.amountInCents,
    });
  });

  it("rejects an insufficient-balance removal without creating a ledger row", async () => {
    const { owner, team } = await createManagedTeam();
    await transactionData.createTeamTransaction(
      owner.id,
      transactionInput(team.id, randomUUID(), {
        amountInCents: 10_000,
        type: "ADD",
      }),
    );

    await expect(
      transactionData.createTeamTransaction(
        owner.id,
        transactionInput(team.id, randomUUID(), {
          amountInCents: 10_001,
          type: "REMOVE",
        }),
      ),
    ).rejects.toMatchObject({
      name: "InsufficientBalanceError",
      balanceInCents: 10_000,
    });
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(1);
  });

  it("serializes concurrent removals so the committed ledger cannot go negative", async () => {
    const { owner, team } = await createManagedTeam();
    await transactionData.createTeamTransaction(
      owner.id,
      transactionInput(team.id, randomUUID(), {
        amountInCents: 10_000,
        type: "ADD",
      }),
    );

    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((idempotencyKey) =>
        transactionData.createTeamTransaction(
          owner.id,
          transactionInput(team.id, idempotencyKey, {
            amountInCents: 7_500,
            type: "REMOVE",
          }),
        ),
      ),
    );
    const committed = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === "rejected",
    );

    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        name: "InsufficientBalanceError",
        balanceInCents: 2_500,
      },
    });

    const totals = await db.transaction.groupBy({
      by: ["type"],
      where: { teamId: team.id },
      _sum: { amountInCents: true },
    });
    expect(totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ADD",
          _sum: { amountInCents: 10_000 },
        }),
        expect.objectContaining({
          type: "REMOVE",
          _sum: { amountInCents: 7_500 },
        }),
      ]),
    );
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(2);
  });

  it("does not distinguish unknown and cross-team transaction targets", async () => {
    const { owner, team } = await createManagedTeam();
    const otherOwner = await db.user.create({
      data: {
        name: "Synthetic other owner",
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const otherTeam = await db.team.create({
      data: {
        name: "Disposable other ledger",
        createdById: otherOwner.id,
      },
    });
    await db.teamMembership.create({
      data: {
        teamId: otherTeam.id,
        userId: otherOwner.id,
        role: "ADMIN",
        status: "APPROVED",
        approvedAt: new Date("2026-07-14T00:00:00.000Z"),
        approvedById: otherOwner.id,
      },
    });
    const removedTeam = await db.team.create({
      data: {
        name: "Disposable removed ledger",
        createdById: otherOwner.id,
      },
    });
    await db.team.delete({ where: { id: removedTeam.id } });
    authenticateAs(owner.id);

    const actionInput = {
      amount: "1.00",
      note: "Synthetic authorization entry",
      transactionDate: "2026-07-14",
      type: "ADD" as const,
    };
    const unknownResult = await transactionActions.createTransaction(
      removedTeam.id,
      randomUUID(),
      actionInput,
    );
    const crossTeamResult = await transactionActions.createTransaction(
      otherTeam.id,
      randomUUID(),
      actionInput,
    );
    const ownedTeamResult = await transactionActions.createTransaction(
      team.id,
      randomUUID(),
      actionInput,
    );

    const genericResourceError = {
      status: "error",
      message:
        "This team is unavailable or you do not have permission to change its ledger.",
    };
    expect(unknownResult).toEqual(genericResourceError);
    expect(crossTeamResult).toEqual(genericResourceError);
    expect(ownedTeamResult.status).toBe("success");
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(1);
    await expect(
      db.transaction.count({ where: { teamId: otherTeam.id } }),
    ).resolves.toBe(0);
  });

  it("preserves count, balance, and attribution through actor disable and hard delete", async () => {
    const { owner, team } = await createManagedTeam();
    const { user: actor } = await createApprovedMember(
      team.id,
      owner.id,
      "MODERATOR",
      "Synthetic actor",
    );
    await db.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: actor.id,
        expires: new Date("2027-07-14T00:00:00.000Z"),
      },
    });
    await transactionData.createTeamTransaction(
      actor.id,
      transactionInput(team.id, randomUUID()),
    );

    const before = await dashboard.getDashboardData(owner.id, team.id);
    expect(before).not.toBeNull();
    if (!before) {
      throw new Error("Synthetic dashboard fixture failed.");
    }

    const disabled = await userLifecycle.disableUserAndRevokeSessions(
      actor.id,
      new Date("2026-07-15T00:00:00.000Z"),
    );
    expect(disabled.status).toBe("disabled");
    await expect(db.session.count({ where: { userId: actor.id } })).resolves.toBe(
      0,
    );

    const afterDisable = await dashboard.getDashboardData(owner.id, team.id);
    expect(afterDisable).toMatchObject({
      balanceInCents: before.balanceInCents,
      transactionHistory: {
        transactions: [
          expect.objectContaining({
            createdByName: "Synthetic actor",
          }),
        ],
      },
    });

    const deleted = await userLifecycle.hardDeleteUser(actor.id);
    expect(deleted).toEqual({ status: "deleted" });

    const afterDelete = await dashboard.getDashboardData(owner.id, team.id);
    expect(afterDelete).not.toBeNull();
    if (!afterDelete) {
      throw new Error("Synthetic dashboard fixture failed.");
    }

    expect(afterDelete.balanceInCents).toBe(before.balanceInCents);
    expect(afterDelete.transactionHistory.transactions).toHaveLength(
      before.transactionHistory.transactions.length,
    );
    expect(afterDelete.transactionHistory.transactions[0]?.createdByName).toBe(
      "Synthetic actor",
    );

    const retainedTransaction = await db.transaction.findFirstOrThrow({
      where: { teamId: team.id },
    });
    expect(retainedTransaction).toMatchObject({
      userId: null,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: "Synthetic actor",
    });
  });

  it("blocks creator hard deletion until ownership is transferred", async () => {
    const { owner, team } = await createManagedTeam();
    const { user: successor } = await createApprovedMember(
      team.id,
      owner.id,
    );
    await transactionData.createTeamTransaction(
      owner.id,
      transactionInput(team.id, randomUUID()),
    );

    await expect(userLifecycle.hardDeleteUser(owner.id)).resolves.toEqual({
      status: "ownership_transfer_required",
    });
    await expect(db.team.count({ where: { id: team.id } })).resolves.toBe(1);
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(1);

    const transfer = await userLifecycle.transferTeamOwnership(owner.id, {
      teamId: team.id,
      newOwnerId: successor.id,
    });
    expect(transfer).toMatchObject({
      changed: true,
      previousOwnerId: owner.id,
      newOwnerId: successor.id,
    });
    await expect(userLifecycle.hardDeleteUser(owner.id)).resolves.toEqual({
      status: "deleted",
    });

    const retainedTeam = await db.team.findUniqueOrThrow({
      where: { id: team.id },
    });
    const retainedTransaction = await db.transaction.findFirstOrThrow({
      where: { teamId: team.id },
    });
    const successorMembership = await db.teamMembership.findUniqueOrThrow({
      where: {
        teamId_userId: {
          teamId: team.id,
          userId: successor.id,
        },
      },
    });

    expect(retainedTeam.createdById).toBe(successor.id);
    expect(successorMembership.role).toBe("ADMIN");
    expect(retainedTransaction).toMatchObject({
      userId: null,
      actorIdSnapshot: owner.id,
      actorNameSnapshot: "Synthetic owner",
    });

    const retainedDashboard = await dashboard.getDashboardData(
      successor.id,
      team.id,
    );
    expect(retainedDashboard).toMatchObject({
      balanceInCents: 12_500,
      transactionHistory: {
        transactions: [
          expect.objectContaining({ createdByName: "Synthetic owner" }),
        ],
      },
    });
  });

  it("installs and enforces the positive transaction amount CHECK", async () => {
    const { owner, team } = await createManagedTeam();
    const constraints = await db.$queryRaw<
      Array<{ validated: boolean; constraintType: string }>
    >`
      SELECT
        constraint_record.convalidated AS "validated",
        constraint_record.contype::text AS "constraintType"
      FROM pg_constraint AS constraint_record
      INNER JOIN pg_class AS table_record
        ON table_record.oid = constraint_record.conrelid
      INNER JOIN pg_namespace AS namespace_record
        ON namespace_record.oid = table_record.relnamespace
      WHERE namespace_record.nspname = current_schema()
        AND table_record.relname = 'Transaction'
        AND constraint_record.conname = 'Transaction_amountInCents_positive_check'
    `;

    expect(constraints).toEqual([{ validated: true, constraintType: "c" }]);

    for (const amountInCents of [0, -1]) {
      await expect(
        db.transaction.create({
          data: {
            teamId: team.id,
            userId: owner.id,
            idempotencyKey: randomUUID(),
            actorIdSnapshot: owner.id,
            actorNameSnapshot: "Synthetic owner",
            amountInCents,
            note: null,
            type: "ADD",
            transactionDate: TRANSACTION_DATE,
          },
        }),
      ).rejects.toBeInstanceOf(Error);
    }

    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(0);
  });

  it("keeps aggregate and history in one RepeatableRead snapshot", async () => {
    const { owner, team } = await createManagedTeam();
    await transactionData.createTeamTransaction(
      owner.id,
      transactionInput(team.id, randomUUID(), { amountInCents: 10_000 }),
    );
    let committedWriterId: string | null = null;

    const snapshot = await dashboard.getDashboardData(owner.id, team.id, {
      afterAggregate: async () => {
        const writerResult = await transactionData.createTeamTransaction(
          owner.id,
          transactionInput(team.id, randomUUID(), { amountInCents: 500 }),
        );
        committedWriterId = writerResult.transaction.id;
      },
    });

    expect(committedWriterId).not.toBeNull();
    expect(snapshot).toMatchObject({
      totalAddedInCents: 10_000,
      totalRemovedInCents: 0,
      balanceInCents: 10_000,
    });
    expect(snapshot?.transactionHistory.transactions).toHaveLength(1);
    expect(
      snapshot?.transactionHistory.transactions.some(
        ({ id }) => id === committedWriterId,
      ),
    ).toBe(false);

    const freshSnapshot = await dashboard.getDashboardData(owner.id, team.id);
    expect(freshSnapshot).toMatchObject({
      totalAddedInCents: 10_500,
      totalRemovedInCents: 0,
      balanceInCents: 10_500,
    });
    expect(freshSnapshot?.transactionHistory.transactions).toHaveLength(2);
    expect(
      freshSnapshot?.transactionHistory.transactions.some(
        ({ id }) => id === committedWriterId,
      ),
    ).toBe(true);
  });

  it("paginates a 1,025-row ledger in stable order without gaps or duplicates", async () => {
    const { owner, team } = await createManagedTeam();
    const sharedCreatedAt = new Date("2026-07-15T03:00:00.000Z");
    const ledgerSize = 1_025;

    await db.transaction.createMany({
      data: Array.from({ length: ledgerSize }, (_, index) => ({
        teamId: team.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        actorIdSnapshot: owner.id,
        actorNameSnapshot: "Synthetic owner",
        type: index % 5 === 0 ? ("REMOVE" as const) : ("ADD" as const),
        amountInCents: index + 1,
        note: null,
        transactionDate: TRANSACTION_DATE,
        createdAt: sharedCreatedAt,
      })),
    });

    const expectedOrder = await db.transaction.findMany({
      where: {
        teamId: team.id,
      },
      orderBy: [
        { transactionDate: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: {
        id: true,
      },
    });
    const initialDashboard = await dashboard.getDashboardData(owner.id, team.id);

    expect(initialDashboard).not.toBeNull();
    if (!initialDashboard) {
      throw new Error("Synthetic pagination fixture failed.");
    }

    const collectedIds = initialDashboard.transactionHistory.transactions.map(
      ({ id }) => id,
    );
    let cursor = initialDashboard.transactionHistory.nextCursor;
    let pageCount = 1;

    while (cursor) {
      const page = await dashboard.getTransactionHistoryPage(
        owner.id,
        team.id,
        cursor,
      );

      expect(page).not.toBeNull();
      if (!page) {
        throw new Error("Synthetic pagination page was unexpectedly denied.");
      }

      collectedIds.push(...page.transactions.map(({ id }) => id));
      cursor = page.nextCursor;
      pageCount += 1;

      if (pageCount > 100) {
        throw new Error("Synthetic pagination did not terminate.");
      }
    }

    expect(collectedIds).toHaveLength(ledgerSize);
    expect(new Set(collectedIds)).toHaveLength(ledgerSize);
    expect(collectedIds).toEqual(expectedOrder.map(({ id }) => id));
    expect(pageCount).toBe(41);
  });

  it("rejects a valid transaction cursor owned by another team", async () => {
    const { owner, team } = await createManagedTeam();
    const otherTeam = await db.team.create({
      data: {
        name: "Other disposable test ledger",
        createdById: owner.id,
      },
    });
    await db.teamMembership.create({
      data: {
        teamId: otherTeam.id,
        userId: owner.id,
        role: "ADMIN",
        status: "APPROVED",
        approvedAt: new Date(),
        approvedById: owner.id,
      },
    });
    const otherTransaction = await db.transaction.create({
      data: {
        teamId: otherTeam.id,
        userId: owner.id,
        idempotencyKey: randomUUID(),
        actorIdSnapshot: owner.id,
        actorNameSnapshot: "Synthetic owner",
        type: "ADD",
        amountInCents: 100,
        note: null,
        transactionDate: TRANSACTION_DATE,
      },
    });

    await expect(
      dashboard.getTransactionHistoryPage(
        owner.id,
        team.id,
        otherTransaction.id,
      ),
    ).resolves.toBeNull();
  });

  it("navigates every group collection across bounded pages without cross-team cursor access", async () => {
    const owner = await db.user.create({
      data: {
        name: "Pagination owner",
        email: "pagination-owner@example.test",
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const viewer = await db.user.create({
      data: {
        name: "Pagination viewer",
        email: "pagination-viewer@example.test",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const requester = await db.user.create({
      data: {
        name: "Pagination requester",
        email: "pagination-requester@example.test",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const collectionSize = groupsQuery.GROUP_MEMBERSHIP_COLLECTION_LIMIT + 3;

    await db.team.createMany({
      data: [
        ...Array.from({ length: collectionSize }, (_, index) => ({
          name: `Member team ${String(index).padStart(3, "0")}`,
          createdById: owner.id,
        })),
        ...Array.from({ length: collectionSize }, (_, index) => ({
          name: `Open team ${String(index).padStart(3, "0")}`,
          createdById: owner.id,
        })),
      ],
    });
    const memberTeams = await db.team.findMany({
      where: { name: { startsWith: "Member team " } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const openTeams = await db.team.findMany({
      where: { name: { startsWith: "Open team " } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const approvedAt = new Date("2026-07-15T04:00:00.000Z");

    await db.teamMembership.createMany({
      data: [
        ...[...memberTeams, ...openTeams].map((team) => ({
          teamId: team.id,
          userId: owner.id,
          role: "ADMIN" as const,
          status: "APPROVED" as const,
          approvedAt,
          approvedById: owner.id,
        })),
        ...memberTeams.map((team) => ({
          teamId: team.id,
          userId: viewer.id,
          role: "MEMBER" as const,
          status: "APPROVED" as const,
          approvedAt,
          approvedById: owner.id,
        })),
        ...memberTeams.map((team) => ({
          teamId: team.id,
          userId: requester.id,
          role: "MEMBER" as const,
          status: "PENDING" as const,
          approvedAt: null,
          approvedById: null,
        })),
      ],
    });

    const firstViewerPage = await groupsQuery.getGroupsPageData(viewer.id);
    expect(firstViewerPage.approvedTeams).toHaveLength(
      groupsQuery.GROUP_MEMBERSHIP_COLLECTION_LIMIT,
    );
    expect(firstViewerPage.availableTeams).toHaveLength(
      groupsQuery.AVAILABLE_TEAM_COLLECTION_LIMIT,
    );
    expect(firstViewerPage.nextCursors.memberships).not.toBeNull();
    expect(firstViewerPage.nextCursors.availableTeams).not.toBeNull();

    const finalViewerPage = await groupsQuery.getGroupsPageData(viewer.id, {
      memberships: firstViewerPage.nextCursors.memberships ?? undefined,
      availableTeams: firstViewerPage.nextCursors.availableTeams ?? undefined,
    });
    expect(finalViewerPage?.approvedTeams).toHaveLength(3);
    expect(finalViewerPage?.availableTeams).toHaveLength(3);
    expect(finalViewerPage?.nextCursors.memberships).toBeNull();
    expect(finalViewerPage?.nextCursors.availableTeams).toBeNull();

    const firstApprovalPage = await groupsQuery.getGroupsPageData(owner.id);
    expect(firstApprovalPage.adminPendingApprovals).toHaveLength(
      groupsQuery.PENDING_APPROVAL_COLLECTION_LIMIT,
    );
    expect(firstApprovalPage.nextCursors.adminPendingApprovals).not.toBeNull();
    const finalApprovalPage = await groupsQuery.getGroupsPageData(owner.id, {
      adminPendingApprovals:
        firstApprovalPage.nextCursors.adminPendingApprovals ?? undefined,
    });
    expect(finalApprovalPage?.adminPendingApprovals).toHaveLength(3);
    expect(finalApprovalPage?.nextCursors.adminPendingApprovals).toBeNull();

    const lastViewerMembership = await db.teamMembership.findFirstOrThrow({
      where: {
        userId: viewer.id,
        status: "APPROVED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const emptyMembershipPage = await groupsQuery.getGroupsPageData(viewer.id, {
      memberships: lastViewerMembership.id,
    });
    expect(emptyMembershipPage).toMatchObject({
      approvedTeams: [],
      pendingTeams: [],
      nextCursors: { memberships: null },
    });

    const ownerMembership = await db.teamMembership.findFirstOrThrow({
      where: { userId: owner.id },
      select: { id: true },
    });
    await expect(
      groupsQuery.getGroupsPageData(viewer.id, {
        memberships: ownerMembership.id,
      }),
    ).resolves.toBeNull();

    const foreignApproval = await db.teamMembership.findFirstOrThrow({
      where: { userId: requester.id, status: "PENDING" },
      select: { id: true },
    });
    await expect(
      groupsQuery.getGroupsPageData(viewer.id, {
        adminPendingApprovals: foreignApproval.id,
      }),
    ).resolves.toBeNull();
  });

  it("navigates administration users, invitations, teams, and team members with authorized cursors", async () => {
    const administrator = await db.user.create({
      data: {
        name: "Pagination administrator",
        email: "admin-pagination@example.test",
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const userCount =
      Math.max(
        adminWorkflows.ADMIN_USER_LIMIT,
        adminWorkflows.ADMIN_TEAM_MEMBER_LIMIT,
      ) + 3;

    await db.user.createMany({
      data: Array.from({ length: userCount }, (_, index) => ({
        name: `Administrative user ${index}`,
        email: `admin-user-${String(index).padStart(3, "0")}@example.test`,
        role: "MEMBER" as const,
        status: "ACTIVE" as const,
      })),
    });
    const memberUsers = await db.user.findMany({
      where: { email: { startsWith: "admin-user-" } },
      orderBy: [{ email: "asc" }, { id: "asc" }],
      select: { id: true, email: true },
    });
    const teamCount = adminWorkflows.ADMIN_TEAM_LIMIT + 3;

    await db.team.createMany({
      data: Array.from({ length: teamCount }, (_, index) => ({
        name:
          index === 0
            ? "000 Administrative member page"
            : `Administrative team ${String(index).padStart(3, "0")}`,
        createdById: administrator.id,
      })),
    });
    const teams = await db.team.findMany({
      where: { createdById: administrator.id },
      orderBy: [
        { deletedAt: { sort: "asc", nulls: "first" } },
        { name: "asc" },
        { id: "asc" },
      ],
      select: { id: true },
    });
    const memberTeam = teams[0];

    if (!memberTeam) {
      throw new Error("The administration pagination team was not created.");
    }

    await db.teamMembership.createMany({
      data: [
        ...teams.map((team) => ({
          teamId: team.id,
          userId: administrator.id,
          role: "ADMIN" as const,
          status: "APPROVED" as const,
          approvedAt: new Date("2026-07-15T04:30:00.000Z"),
          approvedById: administrator.id,
        })),
        ...memberUsers.map((user) => ({
          teamId: memberTeam.id,
          userId: user.id,
          role: "MEMBER" as const,
          status: "APPROVED" as const,
          approvedAt: new Date("2026-07-15T04:30:00.000Z"),
          approvedById: administrator.id,
        })),
      ],
    });
    const invitationCount = adminWorkflows.ADMIN_INVITATION_LIMIT + 3;
    const invitationCreatedAt = new Date("2026-07-15T04:30:00.000Z");

    await db.invitation.createMany({
      data: Array.from({ length: invitationCount }, (_, index) => ({
        email: `admin-invite-${String(index).padStart(3, "0")}@example.test`,
        status: "PENDING" as const,
        createdAt: invitationCreatedAt,
        expiresAt: new Date(invitationCreatedAt.getTime() + 60 * 60 * 1_000),
      })),
    });

    const firstPage = await adminWorkflows.getAdminConsoleData(administrator.id);
    expect(firstPage).not.toBeNull();

    if (!firstPage) {
      throw new Error("The administration pagination fixture was denied.");
    }

    expect(firstPage.users).toHaveLength(adminWorkflows.ADMIN_USER_LIMIT);
    expect(firstPage.invitations).toHaveLength(
      adminWorkflows.ADMIN_INVITATION_LIMIT,
    );
    expect(firstPage.teams).toHaveLength(adminWorkflows.ADMIN_TEAM_LIMIT);
    expect(firstPage.nextCursors).toEqual({
      users: expect.any(String),
      invitations: expect.any(String),
      teams: expect.any(String),
    });

    async function collectAdminCollection(
      key: "users" | "invitations" | "teams",
      initial: NonNullable<typeof firstPage>,
    ) {
      const values = initial[key].map((item) =>
        key === "teams"
          ? (item as (typeof initial.teams)[number]).teamId
          : (item as (typeof initial.users)[number]).email,
      );
      let cursor = initial.nextCursors[key];
      let finalPage = initial;

      while (cursor) {
        const page = await adminWorkflows.getAdminConsoleData(
          administrator.id,
          undefined,
          { [key]: cursor },
        );

        if (!page) {
          throw new Error(`The ${key} cursor was unexpectedly denied.`);
        }

        values.push(
          ...page[key].map((item) =>
            key === "teams"
              ? (item as (typeof page.teams)[number]).teamId
              : (item as (typeof page.users)[number]).email,
          ),
        );
        cursor = page.nextCursors[key];
        finalPage = page;
      }

      expect(finalPage.nextCursors[key]).toBeNull();
      return values;
    }

    const [userEmails, invitationEmails, teamIds] = await Promise.all([
      collectAdminCollection("users", firstPage),
      collectAdminCollection("invitations", firstPage),
      collectAdminCollection("teams", firstPage),
    ]);
    const expectedUsers = await db.user.findMany({
      where: {
        email: { not: null },
        deletedAt: null,
        status: { not: "DELETED" },
      },
      orderBy: [{ email: "asc" }, { id: "asc" }],
      select: { email: true },
    });
    const expectedInvitations = await db.invitation.findMany({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { email: true },
    });

    expect(userEmails).toEqual(expectedUsers.map(({ email }) => email));
    expect(invitationEmails).toEqual(
      expectedInvitations.map(({ email }) => email),
    );
    expect(teamIds).toEqual(teams.map(({ id }) => id));
    expect(new Set(userEmails)).toHaveLength(userEmails.length);
    expect(new Set(invitationEmails)).toHaveLength(invitationEmails.length);
    expect(new Set(teamIds)).toHaveLength(teamIds.length);

    const firstMemberTeam = firstPage.teams.find(
      (team) => team.teamId === memberTeam.id,
    );
    expect(firstMemberTeam?.members).toHaveLength(
      adminWorkflows.ADMIN_TEAM_MEMBER_LIMIT,
    );
    expect(firstMemberTeam?.nextMemberCursor).not.toBeNull();
    const finalMemberPage = await adminWorkflows.getAdminConsoleData(
      administrator.id,
      undefined,
      {
        memberTeamId: memberTeam.id,
        members: firstMemberTeam?.nextMemberCursor ?? undefined,
      },
    );
    const finalMemberTeam = finalMemberPage?.teams.find(
      (team) => team.teamId === memberTeam.id,
    );
    expect(finalMemberTeam?.members.length).toBeGreaterThan(0);
    expect(finalMemberTeam?.nextMemberCursor).toBeNull();

    const lastUserEmail = expectedUsers.at(-1)?.email;

    if (!lastUserEmail) {
      throw new Error("The final administration user cursor was unavailable.");
    }

    const emptyUserPage = await adminWorkflows.getAdminConsoleData(
      administrator.id,
      undefined,
      { users: lastUserEmail },
    );
    expect(emptyUserPage?.users).toEqual([]);
    expect(emptyUserPage?.nextCursors.users).toBeNull();

    await expect(
      adminWorkflows.getAdminConsoleData(
        administrator.id,
        "definitely-no-match",
        { users: administrator.email ?? undefined },
      ),
    ).resolves.toBeNull();
    await expect(
      adminWorkflows.getAdminConsoleData(memberUsers[0]?.id ?? ""),
    ).resolves.toBeNull();
  });

  it("atomically enforces a shared durable rate-limit bucket", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () =>
        rateLimit.checkUserRateLimit(
          {
            scope: "integration-rate-limit",
            userId: "synthetic-rate-limit-subject",
            limit: 10,
            windowSeconds: 60,
          },
          {
            now: new Date("2026-07-15T04:10:30.000Z"),
            secret: "disposable-postgres-rate-limit-test-secret",
          },
        ),
      ),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(10);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(2);

    const bucket = await db.rateLimitBucket.findFirstOrThrow({
      where: {
        scope: "integration-rate-limit",
      },
    });

    expect(bucket.count).toBe(12);
    expect(bucket.subjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bucket.subjectHash).not.toContain("synthetic-rate-limit-subject");
  });

  it("makes simultaneous duplicate membership requests idempotent", async () => {
    const { owner, team } = await createManagedTeam();
    const requester = await db.user.create({
      data: {
        name: "Synthetic requester",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    authenticateAs(requester.id);

    const results = await Promise.all([
      groupActions.requestTeamAccess(team.id),
      groupActions.requestTeamAccess(team.id),
    ]);

    expect(results.every((result) => result.status === "success")).toBe(true);
    const memberships = await db.teamMembership.findMany({
      where: {
        teamId: team.id,
        userId: requester.id,
      },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.status).toBe("PENDING");
    expect(owner.id).not.toBe(requester.id);
  });

  it("allows exactly one of two simultaneous approvals", async () => {
    const { owner, team } = await createManagedTeam();
    const { user: secondApprover } = await createApprovedMember(
      team.id,
      owner.id,
      "ADMIN",
      "Synthetic second approver",
    );
    const { membership } = await createPendingMember(team.id);
    actionMocks.auth
      .mockResolvedValueOnce({ user: { id: owner.id } })
      .mockResolvedValueOnce({ user: { id: secondApprover.id } });

    const results = await Promise.all([
      groupActions.approveTeamAccess(membership.id),
      groupActions.approveTeamAccess(membership.id),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "error",
      "success",
    ]);
    const approved = await db.teamMembership.findUniqueOrThrow({
      where: { id: membership.id },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect([owner.id, secondApprover.id]).toContain(approved.approvedById);
  });

  it("keeps the first approver and timestamp for stale approval retries", async () => {
    const { owner, team } = await createManagedTeam();
    const { user: secondApprover } = await createApprovedMember(
      team.id,
      owner.id,
      "ADMIN",
      "Synthetic second approver",
    );
    const { membership } = await createPendingMember(team.id);
    authenticateAs(owner.id);

    const firstResult = await groupActions.approveTeamAccess(membership.id);
    expect(firstResult.status).toBe("success");
    const firstApprovedState = await db.teamMembership.findUniqueOrThrow({
      where: { id: membership.id },
    });

    authenticateAs(secondApprover.id);
    const staleResult = await groupActions.approveTeamAccess(membership.id);
    expectUnavailableGroupResult(staleResult);
    const retainedState = await db.teamMembership.findUniqueOrThrow({
      where: { id: membership.id },
    });

    expect(retainedState.approvedById).toBe(owner.id);
    expect(retainedState.approvedAt?.getTime()).toBe(
      firstApprovedState.approvedAt?.getTime(),
    );
  });

  it("returns a stable result when the pending membership is deleted during approval", async () => {
    const { owner, team } = await createManagedTeam();
    const { membership } = await createPendingMember(team.id);
    authenticateAs(owner.id);

    const result = await runActionStartedBeforeLockedMutation(
      () => groupActions.approveTeamAccess(membership.id),
      async (tx) => {
        await tx.teamMembership.delete({ where: { id: membership.id } });
      },
    );

    expectUnavailableGroupResult(result);
    await expect(
      db.teamMembership.findUnique({ where: { id: membership.id } }),
    ).resolves.toBeNull();
  });

  it("rechecks authorization when the approver is revoked during approval", async () => {
    const { owner, team } = await createManagedTeam();
    const { membership } = await createPendingMember(team.id);
    authenticateAs(owner.id);

    const result = await runActionStartedBeforeLockedMutation(
      () => groupActions.approveTeamAccess(membership.id),
      async (tx) => {
        await tx.teamMembership.delete({
          where: {
            teamId_userId: {
              teamId: team.id,
              userId: owner.id,
            },
          },
        });
      },
    );

    expectUnavailableGroupResult(result);
    const pending = await db.teamMembership.findUniqueOrThrow({
      where: { id: membership.id },
    });
    expect(pending.status).toBe("PENDING");
    expect(pending.approvedById).toBeNull();
  });

  it("returns a stable result when the team is deleted during approval", async () => {
    const { owner, team } = await createManagedTeam();
    const { membership } = await createPendingMember(team.id);
    authenticateAs(owner.id);

    const result = await runActionStartedBeforeLockedMutation(
      () => groupActions.approveTeamAccess(membership.id),
      async (tx) => {
        await tx.team.delete({ where: { id: team.id } });
      },
    );

    expectUnavailableGroupResult(result);
    await expect(db.team.findUnique({ where: { id: team.id } })).resolves.toBeNull();
    await expect(
      db.teamMembership.findUnique({ where: { id: membership.id } }),
    ).resolves.toBeNull();
  });

  it("admits only an unexpired, single-use provisioned identity", async () => {
    const now = new Date("2026-07-15T05:00:00.000Z");
    const administrator = await db.user.create({
      data: {
        name: "Synthetic admission administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "not-provisioned@example.test",
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      db.user.count({ where: { email: "not-provisioned@example.test" } }),
    ).resolves.toBe(0);

    const provisioned = await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "  Invited.Identity@Example.TEST ",
      now,
      expiresAt: new Date("2026-07-22T05:00:00.000Z"),
    });

    expect(provisioned.status).toBe("created");
    const pendingUser = await db.user.findUniqueOrThrow({
      where: { email: "invited.identity@example.test" },
    });
    expect(pendingUser.status).toBe("PENDING");

    const admissions = await Promise.all([
      invitations.admitInvitedGoogleIdentity(
        repository,
        "Invited.Identity@Example.TEST",
        now,
      ),
      invitations.admitInvitedGoogleIdentity(
        repository,
        "invited.identity@example.test",
        now,
      ),
    ]);

    expect(admissions).toEqual([true, true]);
    await expect(
      db.user.findUniqueOrThrow({ where: { id: pendingUser.id } }),
    ).resolves.toMatchObject({
      email: "invited.identity@example.test",
      status: "ACTIVE",
      disabledAt: null,
      deletedAt: null,
    });
    await expect(
      db.invitation.findUniqueOrThrow({
        where: { id: provisioned.invitationId ?? undefined },
      }),
    ).resolves.toMatchObject({
      status: "ACCEPTED",
      provisionedUserId: pendingUser.id,
      acceptedAt: expect.any(Date),
    });
    await expect(
      db.auditEvent.count({
        where: {
          action: "invitation.accepted",
          targetIdSnapshot: provisioned.invitationId ?? undefined,
        },
      }),
    ).resolves.toBe(1);
  });

  it("admits a valid future invitation using one persisted application clock", async () => {
    const now = new Date("2026-07-15T06:00:00.000Z");
    const administrator = await db.user.create({
      data: {
        name: "Synthetic invitation administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    const provisioned = await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "future@example.test",
      now,
      expiresAt: new Date("2026-07-15T06:10:00.000Z"),
    });

    await expect(
      db.invitation.findUniqueOrThrow({
        where: { id: provisioned.invitationId ?? undefined },
        select: { createdAt: true, expiresAt: true },
      }),
    ).resolves.toEqual({
      createdAt: now,
      expiresAt: new Date("2026-07-15T06:10:00.000Z"),
    });
    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "future@example.test",
        new Date("2026-07-15T06:09:59.999Z"),
      ),
    ).resolves.toBe(true);
  });

  it("rejects an already-expired invitation", async () => {
    const now = new Date("2026-07-15T06:00:00.000Z");
    const administrator = await db.user.create({
      data: {
        name: "Synthetic invitation administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "expired@example.test",
      now,
      expiresAt: new Date("2026-07-15T06:10:00.000Z"),
    });
    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "expired@example.test",
        new Date("2026-07-15T06:10:00.001Z"),
      ),
    ).resolves.toBe(false);
  });

  it("rejects an invitation at the exact expiry boundary", async () => {
    const now = new Date("2026-07-15T06:00:00.000Z");
    const expiresAt = new Date("2026-07-15T06:10:00.000Z");
    const administrator = await db.user.create({
      data: {
        name: "Synthetic invitation administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "boundary@example.test",
      now,
      expiresAt,
    });
    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "boundary@example.test",
        expiresAt,
      ),
    ).resolves.toBe(false);
  });

  it("persists a consistent invitation clock under moderate application/database skew", async () => {
    const [{ databaseNow }] = await db.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT clock_timestamp() AS "databaseNow"
    `;

    if (!databaseNow) {
      throw new Error("The disposable database clock was unavailable.");
    }

    const applicationNow = new Date(databaseNow.getTime() - 2 * 60 * 1_000);
    const expiresAt = new Date(applicationNow.getTime() + 10 * 60 * 1_000);
    const administrator = await db.user.create({
      data: {
        name: "Synthetic skewed-clock administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: applicationNow,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    const provisioned = await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "skewed-clock@example.test",
      now: applicationNow,
      expiresAt,
    });

    await expect(
      db.invitation.findUniqueOrThrow({
        where: { id: provisioned.invitationId ?? undefined },
        select: { createdAt: true, expiresAt: true },
      }),
    ).resolves.toEqual({ createdAt: applicationNow, expiresAt });
  });

  it("keeps revoked invitations outside the admission boundary", async () => {
    const now = new Date("2026-07-15T06:00:00.000Z");
    const administrator = await db.user.create({
      data: {
        name: "Synthetic invitation administrator",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    await invitations.provisionInvitation(repository, {
      actorUserId: administrator.id,
      email: "revoked@example.test",
      now,
      expiresAt: new Date("2026-07-22T06:00:00.000Z"),
    });
    await invitations.revokeInvitation(repository, {
      actorUserId: administrator.id,
      email: "revoked@example.test",
      now: new Date("2026-07-15T06:01:00.000Z"),
    });
    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "revoked@example.test",
        new Date("2026-07-15T06:02:00.000Z"),
      ),
    ).resolves.toBe(false);

    await expect(
      db.user.findUniqueOrThrow({ where: { email: "revoked@example.test" } }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("revokes every older session before a fresh admitted sign-in", async () => {
    const now = new Date("2026-07-15T06:30:00.000Z");
    const user = await db.user.create({
      data: {
        name: "Synthetic reauthentication user",
        email: "reauthentication@example.test",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: new Date("2026-07-15T05:30:00.000Z"),
      },
    });
    await db.session.createMany({
      data: [
        {
          sessionToken: hashSessionToken("synthetic-prior-session-one"),
          userId: user.id,
          expires: new Date("2026-07-15T12:00:00.000Z"),
        },
        {
          sessionToken: hashSessionToken("synthetic-prior-session-two"),
          userId: user.id,
          expires: new Date("2026-07-15T12:00:00.000Z"),
        },
      ],
    });
    const repository = invitations.createPrismaInvitationRepository(db);

    await expect(
      invitations.admitInvitedGoogleIdentity(
        repository,
        "Reauthentication@Example.Test",
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
  });

  it("stores only token digests and rejects an offboarded session on lookup", async () => {
    const user = await db.user.create({
      data: {
        name: "Synthetic session user",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const adapter = hardenAuthAdapter(PrismaAdapter(db));
    const rawSessionToken = "synthetic-opaque-session-cookie";
    const updatedExpiry = new Date("2026-07-16T08:00:00.000Z");

    const created = await adapter.createSession?.({
      sessionToken: rawSessionToken,
      userId: user.id,
      expires: new Date("2026-07-16T07:00:00.000Z"),
    });
    expect(created?.sessionToken).toBe(rawSessionToken);

    const persisted = await db.session.findUniqueOrThrow({
      where: {
        sessionToken: hashSessionToken(rawSessionToken),
      },
    });
    expect(persisted.sessionToken).not.toBe(rawSessionToken);
    await expect(adapter.getSessionAndUser?.(rawSessionToken)).resolves.toMatchObject({
      user: { id: user.id },
      session: { sessionToken: rawSessionToken },
    });

    const updated = await adapter.updateSession?.({
      sessionToken: rawSessionToken,
      expires: updatedExpiry,
    });
    expect(updated).toMatchObject({
      sessionToken: rawSessionToken,
      expires: updatedExpiry,
    });

    const disabled = await userLifecycle.disableUserAndRevokeSessions(
      user.id,
      new Date("2026-07-15T07:30:00.000Z"),
    );
    expect(disabled.status).toBe("disabled");

    const raceSessionToken = "synthetic-offboarding-race-cookie";
    await db.session.create({
      data: {
        sessionToken: hashSessionToken(raceSessionToken),
        userId: user.id,
        expires: updatedExpiry,
      },
    });

    await expect(adapter.getSessionAndUser?.(raceSessionToken)).resolves.toBeNull();
    await expect(
      db.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
  });

  it("does not persist provider bearer material through the real adapter", async () => {
    const user = await db.user.create({
      data: {
        name: "Synthetic linked identity",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    const adapter = hardenAuthAdapter(PrismaAdapter(db));

    await adapter.linkAccount?.({
      userId: user.id,
      type: "oauth",
      provider: "google",
      providerAccountId: "synthetic-provider-account",
      refresh_token: "refresh-value",
      access_token: "access-value",
      expires_at: 1_800_000_000,
      token_type: "bearer",
      scope: "openid email profile",
      id_token: "identity-value",
      session_state: "provider-session",
    });

    await expect(
      db.account.findUniqueOrThrow({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId: "synthetic-provider-account",
          },
        },
      }),
    ).resolves.toMatchObject({
      refresh_token: null,
      access_token: null,
      expires_at: null,
      token_type: null,
      scope: null,
      id_token: null,
      session_state: null,
    });
  });

  it("requires the exact team name and a recently authenticated global administrator to quarantine", async () => {
    const now = new Date("2026-07-15T09:00:00.000Z");
    const { owner, team } = await createTeamLifecycleFixture(now);
    const { user: localAdministrator } = await createApprovedMember(
      team.id,
      owner.id,
      "ADMIN",
      "Synthetic local administrator",
    );
    await db.user.update({
      where: { id: localAdministrator.id },
      data: { lastAuthenticatedAt: now },
    });

    await expect(
      teamLifecycle.quarantineTeam(owner.id, {
        teamId: team.id,
        confirmedTeamName: `${team.name} `,
        correlationId: randomUUID(),
        now,
      }),
    ).resolves.toEqual({ status: "confirmation_mismatch" });
    await expect(
      teamLifecycle.quarantineTeam(localAdministrator.id, {
        teamId: team.id,
        confirmedTeamName: team.name,
        correlationId: randomUUID(),
        now,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({
      deletedAt: null,
      deletedById: null,
      purgeAfter: null,
    });
    await expect(
      db.auditEvent.count({ where: { teamIdSnapshot: team.id } }),
    ).resolves.toBe(0);

    const result = await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now,
    });

    expect(result).toEqual({
      status: "quarantined",
      teamId: team.id,
      purgeAfter: new Date("2026-08-14T09:00:00.000Z"),
    });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({
      deletedAt: now,
      deletedById: owner.id,
      purgeAfter: new Date("2026-08-14T09:00:00.000Z"),
    });
  });

  it("makes repeated quarantine idempotent, hides normal reads, and retains the ledger graph", async () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    const { ledgerWrite, owner, team } = await createTeamLifecycleFixture(now);

    const first = await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now,
    });
    const repeated = await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now: new Date("2026-07-15T10:01:00.000Z"),
    });

    expect(first.status).toBe("quarantined");
    expect(repeated).toEqual({
      status: "already_quarantined",
      teamId: team.id,
      purgeAfter: new Date("2026-08-14T10:00:00.000Z"),
    });
    await expect(
      db.auditEvent.count({
        where: {
          action: "TEAM_QUARANTINED",
          teamIdSnapshot: team.id,
        },
      }),
    ).resolves.toBe(1);

    await expect(dashboard.getDashboardData(owner.id, team.id)).resolves.toBeNull();
    await expect(groupsQuery.getFirstApprovedTeamId(owner.id)).resolves.toBeNull();
    const groups = await groupsQuery.getGroupsPageData(owner.id);
    expect([
      ...groups.approvedTeams,
      ...groups.pendingTeams,
      ...groups.availableTeams,
    ]).not.toContainEqual(expect.objectContaining({ teamId: team.id }));
    expect(groups.adminPendingApprovals).not.toContainEqual(
      expect.objectContaining({ teamId: team.id }),
    );

    await expect(
      db.transaction.findUnique({ where: { id: ledgerWrite.transaction.id } }),
    ).resolves.toMatchObject({ teamId: team.id, amountInCents: 12_500 });
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(1);
    await expect(
      db.teamMembership.count({ where: { teamId: team.id } }),
    ).resolves.toBe(2);
  });

  it("restores within the 30-day retention period without losing ledger or memberships", async () => {
    const quarantinedAt = new Date("2026-07-15T11:00:00.000Z");
    const restoreAt = new Date("2026-08-13T11:00:00.000Z");
    const { ledgerWrite, owner, team } =
      await createTeamLifecycleFixture(quarantinedAt);
    await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now: quarantinedAt,
    });
    await db.user.update({
      where: { id: owner.id },
      data: { lastAuthenticatedAt: restoreAt },
    });

    await expect(
      teamLifecycle.restoreTeam(owner.id, {
        teamId: team.id,
        confirmedTeamName: team.name,
        correlationId: randomUUID(),
        now: restoreAt,
      }),
    ).resolves.toEqual({ status: "restored", teamId: team.id });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({
      deletedAt: null,
      deletedById: null,
      purgeAfter: null,
    });
    await expect(
      db.transaction.findUnique({ where: { id: ledgerWrite.transaction.id } }),
    ).resolves.toMatchObject({ teamId: team.id, amountInCents: 12_500 });
    await expect(
      db.teamMembership.count({ where: { teamId: team.id } }),
    ).resolves.toBe(2);

    const restoredDashboard = await dashboard.getDashboardData(owner.id, team.id);
    expect(restoredDashboard).toMatchObject({
      teamId: team.id,
      balanceInCents: 12_500,
      totalAddedInCents: 12_500,
      totalRemovedInCents: 0,
    });
    expect(restoredDashboard?.transactionHistory.transactions).toContainEqual(
      expect.objectContaining({ id: ledgerWrite.transaction.id }),
    );
    const groups = await groupsQuery.getGroupsPageData(owner.id);
    expect(groups.approvedTeams).toContainEqual(
      expect.objectContaining({ teamId: team.id, memberCount: 2 }),
    );
    await expect(
      db.auditEvent.findMany({
        where: { teamIdSnapshot: team.id },
        orderBy: { createdAt: "asc" },
        select: { action: true },
      }),
    ).resolves.toEqual([
      { action: "TEAM_QUARANTINED" },
      { action: "TEAM_RESTORED" },
    ]);
  });

  it("denies restore once the retention deadline has expired", async () => {
    const quarantinedAt = new Date("2026-07-15T12:00:00.000Z");
    const restoreAt = new Date("2026-08-14T12:00:00.001Z");
    const { owner, team } = await createTeamLifecycleFixture(quarantinedAt);
    await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now: quarantinedAt,
    });
    await db.user.update({
      where: { id: owner.id },
      data: { lastAuthenticatedAt: restoreAt },
    });

    await expect(
      teamLifecycle.restoreTeam(owner.id, {
        teamId: team.id,
        confirmedTeamName: team.name,
        correlationId: randomUUID(),
        now: restoreAt,
      }),
    ).resolves.toEqual({ status: "retention_expired" });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({
      deletedAt: quarantinedAt,
      purgeAfter: new Date("2026-08-14T12:00:00.000Z"),
    });
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(1);
    await expect(
      db.teamMembership.count({ where: { teamId: team.id } }),
    ).resolves.toBe(2);
    await expect(
      db.auditEvent.count({
        where: { action: "TEAM_RESTORED", teamIdSnapshot: team.id },
      }),
    ).resolves.toBe(0);
  });

  it("purges only after retention and retains independent audit snapshots", async () => {
    const quarantinedAt = new Date("2026-07-15T13:00:00.000Z");
    const purgeDeadline = new Date("2026-08-14T13:00:00.000Z");
    const { owner, team } = await createTeamLifecycleFixture(quarantinedAt);
    await teamLifecycle.quarantineTeam(owner.id, {
      teamId: team.id,
      confirmedTeamName: team.name,
      correlationId: randomUUID(),
      now: quarantinedAt,
    });

    await expect(
      teamLifecycle.purgeTeamAfterRetention({
        actorEmail: owner.email ?? "",
        teamId: team.id,
        confirmedTeamName: team.name,
        backupReference: "synthetic-backup-before-retention",
        correlationId: randomUUID(),
        now: new Date(purgeDeadline.getTime() - 1),
      }),
    ).resolves.toEqual({ status: "not_eligible" });
    await expect(db.team.findUnique({ where: { id: team.id } })).resolves.not.toBeNull();
    await expect(
      db.auditEvent.count({
        where: {
          action: "TEAM_PERMANENTLY_PURGED",
          teamIdSnapshot: team.id,
        },
      }),
    ).resolves.toBe(0);

    await expect(
      teamLifecycle.purgeTeamAfterRetention({
        actorEmail: owner.email ?? "",
        teamId: team.id,
        confirmedTeamName: team.name,
        backupReference: "synthetic-backup-after-retention",
        correlationId: randomUUID(),
        now: new Date(purgeDeadline.getTime() + 1),
      }),
    ).resolves.toEqual({ status: "purged" });
    await expect(db.team.findUnique({ where: { id: team.id } })).resolves.toBeNull();
    await expect(
      db.transaction.count({ where: { teamId: team.id } }),
    ).resolves.toBe(0);
    await expect(
      db.teamMembership.count({ where: { teamId: team.id } }),
    ).resolves.toBe(0);

    const retainedAuditEvents = await db.auditEvent.findMany({
      where: { teamIdSnapshot: team.id },
      orderBy: { createdAt: "asc" },
      select: {
        action: true,
        actorIdSnapshot: true,
        targetIdSnapshot: true,
        teamIdSnapshot: true,
        metadata: true,
      },
    });
    expect(retainedAuditEvents).toEqual([
      expect.objectContaining({
        action: "TEAM_QUARANTINED",
        actorIdSnapshot: owner.id,
        targetIdSnapshot: team.id,
        teamIdSnapshot: team.id,
      }),
      expect.objectContaining({
        action: "TEAM_PERMANENTLY_PURGED",
        actorIdSnapshot: owner.id,
        targetIdSnapshot: team.id,
        teamIdSnapshot: team.id,
        metadata: expect.objectContaining({
          backupReference: "synthetic-backup-after-retention",
          retentionExpiredAt: purgeDeadline.toISOString(),
        }),
      }),
    ]);

    await db.user.delete({ where: { id: owner.id } });
    await expect(
      db.auditEvent.count({ where: { teamIdSnapshot: team.id } }),
    ).resolves.toBe(2);
  });

  it("disables an active user, revokes every session, and records the transition", async () => {
    const now = new Date("2026-07-15T14:00:00.000Z");
    const correlationId = randomUUID();
    const actor = await db.user.create({
      data: {
        name: "Synthetic workflow administrator",
        email: "workflow.administrator@example.test",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const target = await db.user.create({
      data: {
        name: "Synthetic disable target",
        email: "disable.target@example.test",
        role: "MEMBER",
        status: "ACTIVE",
      },
    });
    await createSyntheticSessions(target.id, 2);
    const repository = adminWorkflows.createPrismaAdminWorkflowRepository(db);

    await expect(
      repository.setUserEnabled({
        actorUserId: actor.id,
        email: " DISABLE.Target@Example.TEST ",
        enabled: false,
        correlationId,
        now,
      }),
    ).resolves.toEqual({ status: "changed", revokedSessionCount: 2 });
    await expect(
      db.user.findUniqueOrThrow({ where: { id: target.id } }),
    ).resolves.toMatchObject({
      role: "MEMBER",
      status: "DISABLED",
      disabledAt: now,
      deletedAt: null,
    });
    await expect(
      db.session.count({ where: { userId: target.id } }),
    ).resolves.toBe(0);
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { correlationId } }),
    ).resolves.toMatchObject({
      action: "user.disabled",
      actorUserId: actor.id,
      actorIdSnapshot: actor.id,
      actorNameSnapshot: "Synthetic workflow administrator",
      targetType: "user",
      targetIdSnapshot: target.id,
      teamIdSnapshot: null,
      correlationId,
      metadata: {
        outcome: "disabled",
        revokedSessionCount: 2,
      },
      createdAt: now,
    });
  });

  it("guards the final global administrator, then demotes an owner independently of team ownership", async () => {
    const now = new Date("2026-07-15T15:00:00.000Z");
    const { owner: createdOwner, team } = await createManagedTeam();
    const owner = await db.user.update({
      where: { id: createdOwner.id },
      data: {
        email: "owner.demote@example.test",
        lastAuthenticatedAt: now,
      },
    });
    await createSyntheticSessions(owner.id, 1);
    const repository = adminWorkflows.createPrismaAdminWorkflowRepository(db);

    await expect(
      repository.setGlobalRole({
        actorUserId: owner.id,
        email: owner.email ?? "",
        role: "MEMBER",
        correlationId: randomUUID(),
        now,
      }),
    ).resolves.toEqual({ status: "last_admin_required" });
    await expect(
      db.user.findUniqueOrThrow({ where: { id: owner.id } }),
    ).resolves.toMatchObject({ role: "ADMIN", status: "ACTIVE" });
    await expect(
      db.session.count({ where: { userId: owner.id } }),
    ).resolves.toBe(1);
    await expect(
      db.auditEvent.count({
        where: {
          action: "user.global_role_changed",
          targetIdSnapshot: owner.id,
        },
      }),
    ).resolves.toBe(0);

    const secondAdministrator = await db.user.create({
      data: {
        name: "Synthetic second global administrator",
        email: "second.administrator@example.test",
        role: "ADMIN",
        status: "ACTIVE",
        lastAuthenticatedAt: now,
      },
    });
    const correlationId = randomUUID();
    await expect(
      repository.setGlobalRole({
        actorUserId: secondAdministrator.id,
        email: owner.email ?? "",
        role: "MEMBER",
        correlationId,
        now,
      }),
    ).resolves.toEqual({ status: "changed", revokedSessionCount: 1 });

    await expect(
      db.user.findUniqueOrThrow({ where: { id: owner.id } }),
    ).resolves.toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({ createdById: owner.id });
    await expect(
      db.teamMembership.findUniqueOrThrow({
        where: { teamId_userId: { teamId: team.id, userId: owner.id } },
      }),
    ).resolves.toMatchObject({ role: "ADMIN", status: "APPROVED" });
    await expect(
      db.session.count({ where: { userId: owner.id } }),
    ).resolves.toBe(0);
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { correlationId } }),
    ).resolves.toMatchObject({
      action: "user.global_role_changed",
      actorUserId: secondAdministrator.id,
      actorIdSnapshot: secondAdministrator.id,
      actorNameSnapshot: "Synthetic second global administrator",
      targetType: "user",
      targetIdSnapshot: owner.id,
      teamIdSnapshot: null,
      metadata: {
        fromRole: "ADMIN",
        toRole: "MEMBER",
        revokedSessionCount: 1,
      },
      createdAt: now,
    });
  });

  it("revokes membership and sessions while retaining a self-contained audit record", async () => {
    const now = new Date("2026-07-15T16:00:00.000Z");
    const { owner: createdOwner, team } = await createManagedTeam();
    const owner = await db.user.update({
      where: { id: createdOwner.id },
      data: {
        email: "membership.actor@example.test",
        lastAuthenticatedAt: now,
      },
    });
    const { membership, user: createdTarget } = await createApprovedMember(
      team.id,
      owner.id,
      "MEMBER",
      "Synthetic revoked member",
    );
    const target = await db.user.update({
      where: { id: createdTarget.id },
      data: { email: "revoked.member@example.test" },
    });
    await createSyntheticSessions(target.id, 2);
    const correlationId = randomUUID();
    const repository = adminWorkflows.createPrismaAdminWorkflowRepository(db);

    await expect(
      repository.revokeMembership({
        actorUserId: owner.id,
        teamId: team.id,
        email: target.email ?? "",
        correlationId,
        now,
      }),
    ).resolves.toEqual({ status: "changed", revokedSessionCount: 2 });
    await expect(
      db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } }),
    ).resolves.toMatchObject({
      status: "REVOKED",
      approvedAt: null,
      approvedById: null,
    });
    await expect(
      db.session.count({ where: { userId: target.id } }),
    ).resolves.toBe(0);
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { correlationId } }),
    ).resolves.toMatchObject({
      action: "team.membership_revoked",
      actorUserId: owner.id,
      actorIdSnapshot: owner.id,
      actorNameSnapshot: "Synthetic owner",
      targetType: "team_membership",
      targetIdSnapshot: membership.id,
      teamIdSnapshot: team.id,
      metadata: {
        previousStatus: "APPROVED",
        subjectIdSnapshot: target.id,
        revokedSessionCount: 2,
      },
      createdAt: now,
    });

    await db.user.delete({ where: { id: target.id } });
    await expect(
      db.teamMembership.findUnique({ where: { id: membership.id } }),
    ).resolves.toBeNull();
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { correlationId } }),
    ).resolves.toMatchObject({
      targetIdSnapshot: membership.id,
      teamIdSnapshot: team.id,
      metadata: expect.objectContaining({ subjectIdSnapshot: target.id }),
    });
  });

  it("requires the exact name before transferring ownership and snapshots both owners", async () => {
    const now = new Date("2026-07-15T17:00:00.000Z");
    const { owner: createdOwner, team } = await createManagedTeam();
    const owner = await db.user.update({
      where: { id: createdOwner.id },
      data: {
        email: "ownership.actor@example.test",
        lastAuthenticatedAt: now,
      },
    });
    const { membership, user: createdTarget } = await createApprovedMember(
      team.id,
      owner.id,
      "MEMBER",
      "Synthetic next owner",
    );
    const target = await db.user.update({
      where: { id: createdTarget.id },
      data: { email: "next.owner@example.test" },
    });
    await createSyntheticSessions(owner.id, 2);
    await createSyntheticSessions(target.id, 1);
    const repository = adminWorkflows.createPrismaAdminWorkflowRepository(db);

    await expect(
      repository.transferOwnership({
        actorUserId: owner.id,
        teamId: team.id,
        newOwnerEmail: target.email ?? "",
        confirmedTeamName: team.name.toLowerCase(),
        correlationId: randomUUID(),
        now,
      }),
    ).resolves.toEqual({ status: "confirmation_mismatch" });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({ createdById: owner.id });
    await expect(
      db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } }),
    ).resolves.toMatchObject({ role: "MEMBER", status: "APPROVED" });
    await expect(
      db.session.count({ where: { userId: { in: [owner.id, target.id] } } }),
    ).resolves.toBe(3);
    await expect(
      db.auditEvent.count({
        where: {
          action: "team.ownership_transferred",
          teamIdSnapshot: team.id,
        },
      }),
    ).resolves.toBe(0);

    const correlationId = randomUUID();
    await expect(
      repository.transferOwnership({
        actorUserId: owner.id,
        teamId: team.id,
        newOwnerEmail: target.email ?? "",
        confirmedTeamName: team.name,
        correlationId,
        now,
      }),
    ).resolves.toEqual({ status: "changed", revokedSessionCount: 3 });
    await expect(
      db.team.findUniqueOrThrow({ where: { id: team.id } }),
    ).resolves.toMatchObject({ createdById: target.id });
    await expect(
      db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } }),
    ).resolves.toMatchObject({ role: "ADMIN", status: "APPROVED" });
    await expect(
      db.user.findUniqueOrThrow({ where: { id: target.id } }),
    ).resolves.toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    await expect(
      db.session.count({ where: { userId: { in: [owner.id, target.id] } } }),
    ).resolves.toBe(0);
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { correlationId } }),
    ).resolves.toMatchObject({
      action: "team.ownership_transferred",
      actorUserId: owner.id,
      actorIdSnapshot: owner.id,
      actorNameSnapshot: "Synthetic owner",
      targetType: "team",
      targetIdSnapshot: team.id,
      teamIdSnapshot: team.id,
      metadata: {
        previousOwnerIdSnapshot: owner.id,
        newOwnerIdSnapshot: target.id,
        targetPromoted: true,
        revokedSessionCount: 3,
      },
      createdAt: now,
    });
  });

  it("enforces append-only audit events without an application-settable bypass", async () => {
    const auditEvent = await db.auditEvent.create({
      data: {
        action: "security.integration",
        actorIdSnapshot: "system",
        actorNameSnapshot: "System",
        targetType: "system",
        targetIdSnapshot: "append-only-policy",
        correlationId: randomUUID(),
      },
    });

    await expect(
      db.auditEvent.update({
        where: {
          id: auditEvent.id,
        },
        data: {
          action: "security.mutated",
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      db.auditEvent.findUniqueOrThrow({ where: { id: auditEvent.id } }),
    ).resolves.toMatchObject({
      action: "security.integration",
    });

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.audit_maintenance = 'on'");
        await tx.auditEvent.delete({
          where: {
            id: auditEvent.id,
          },
        });
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"'),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      db.auditEvent.findUniqueOrThrow({ where: { id: auditEvent.id } }),
    ).resolves.toMatchObject({
      action: "security.integration",
    });
  });
});
