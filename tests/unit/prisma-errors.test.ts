import { describe, expect, it } from "vitest";
import { hasPrismaErrorCode } from "@/lib/prisma-errors";

describe("Prisma error code matching", () => {
  it("matches only an object with the exact requested code", () => {
    expect(hasPrismaErrorCode({ code: "P2034" }, "P2034")).toBe(true);
    expect(hasPrismaErrorCode({ code: "P2002" }, "P2034")).toBe(false);
    expect(hasPrismaErrorCode({ code: 2034 }, "P2034")).toBe(false);
    expect(hasPrismaErrorCode(null, "P2034")).toBe(false);
    expect(hasPrismaErrorCode("P2034", "P2034")).toBe(false);
  });

  it("matches driver-adapter constraint and serialization errors", () => {
    expect(
      hasPrismaErrorCode(
        {
          name: "DriverAdapterError",
          cause: { kind: "TransactionWriteConflict" },
        },
        "P2034",
      ),
    ).toBe(true);
    expect(
      hasPrismaErrorCode(
        {
          name: "DriverAdapterError",
          cause: { kind: "UniqueConstraintViolation" },
        },
        "P2002",
      ),
    ).toBe(true);
    expect(
      hasPrismaErrorCode(
        {
          name: "DriverAdapterError",
          cause: { kind: "ForeignKeyConstraintViolation" },
        },
        "P2003",
      ),
    ).toBe(true);
  });

  it("does not trust unrelated nested adapter errors", () => {
    expect(
      hasPrismaErrorCode(
        {
          name: "DriverAdapterError",
          cause: { kind: "TransactionWriteConflict" },
        },
        "P2002",
      ),
    ).toBe(false);
    expect(
      hasPrismaErrorCode(
        { name: "OtherError", cause: { kind: "TransactionWriteConflict" } },
        "P2034",
      ),
    ).toBe(false);
    expect(
      hasPrismaErrorCode(
        { name: "DriverAdapterError", cause: { kind: "Unknown" } },
        "P2034",
      ),
    ).toBe(false);
  });
});
