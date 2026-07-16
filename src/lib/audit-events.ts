import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

const IDENTIFIER_PATTERN = /^[a-z0-9_.:@/-]+$/i;
const SENSITIVE_METADATA_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|email|note|description)/i;
const EMAIL_LIKE_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AuditEventDatabase = Pick<Prisma.TransactionClient, "auditEvent">;

export interface RecordAuditEventInput {
  action: string;
  actorUserId?: string | null;
  actorIdSnapshot: string;
  actorNameSnapshot: string;
  targetType: string;
  targetIdSnapshot: string;
  teamIdSnapshot?: string | null;
  correlationId: string;
  metadata?: Prisma.InputJsonObject;
  createdAt?: Date;
}

export class InvalidAuditEventError extends Error {
  constructor() {
    super("The audit event is invalid.");
    this.name = "InvalidAuditEventError";
  }
}

export function createAuditCorrelationId() {
  return randomUUID();
}

function assertBoundedIdentifier(value: string, maximumLength: number) {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new InvalidAuditEventError();
  }
}

function assertSafeMetadata(value: Prisma.InputJsonValue, key?: string): void {
  if (key && SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
    throw new InvalidAuditEventError();
  }

  if (typeof value === "string") {
    if (value.length > 128 || EMAIL_LIKE_VALUE_PATTERN.test(value)) {
      throw new InvalidAuditEventError();
    }

    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidAuditEventError();
    }

    return;
  }

  if (value === null || typeof value === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > 32) {
      throw new InvalidAuditEventError();
    }

    for (const entry of value) {
      assertSafeMetadata(entry);
    }

    return;
  }

  const entries = Object.entries(value);

  if (entries.length > 32) {
    throw new InvalidAuditEventError();
  }

  for (const [entryKey, entryValue] of entries) {
    assertSafeMetadata(entryValue, entryKey);
  }
}

export async function recordAuditEvent(
  database: AuditEventDatabase,
  input: RecordAuditEventInput,
) {
  assertBoundedIdentifier(input.action, 80);
  assertBoundedIdentifier(input.actorIdSnapshot, 191);
  assertBoundedIdentifier(input.targetType, 40);
  assertBoundedIdentifier(input.targetIdSnapshot, 191);
  assertBoundedIdentifier(input.correlationId, 64);

  if (input.actorUserId) {
    assertBoundedIdentifier(input.actorUserId, 191);
  }

  if (input.teamIdSnapshot) {
    assertBoundedIdentifier(input.teamIdSnapshot, 191);
  }

  const actorNameSnapshot = input.actorNameSnapshot.trim();

  if (actorNameSnapshot.length < 1 || actorNameSnapshot.length > 160) {
    throw new InvalidAuditEventError();
  }

  if (input.metadata) {
    assertSafeMetadata(input.metadata);
  }

  return database.auditEvent.create({
    data: {
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorIdSnapshot: input.actorIdSnapshot,
      actorNameSnapshot,
      targetType: input.targetType,
      targetIdSnapshot: input.targetIdSnapshot,
      teamIdSnapshot: input.teamIdSnapshot ?? null,
      correlationId: input.correlationId,
      metadata: input.metadata,
      createdAt: input.createdAt,
    },
    select: {
      id: true,
      createdAt: true,
    },
  });
}
