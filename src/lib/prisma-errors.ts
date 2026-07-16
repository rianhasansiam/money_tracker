const DRIVER_ADAPTER_KIND_BY_PRISMA_CODE: Readonly<Record<string, string>> = {
  P2002: "UniqueConstraintViolation",
  P2003: "ForeignKeyConstraintViolation",
  P2034: "TransactionWriteConflict",
};

export function hasPrismaErrorCode(error: unknown, code: string) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === code) {
    return true;
  }

  if (
    !("name" in error) ||
    error.name !== "DriverAdapterError" ||
    !("cause" in error) ||
    typeof error.cause !== "object" ||
    error.cause === null ||
    !("kind" in error.cause)
  ) {
    return false;
  }

  return error.cause.kind === DRIVER_ADAPTER_KIND_BY_PRISMA_CODE[code];
}
