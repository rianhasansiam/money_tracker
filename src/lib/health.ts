const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export async function runReadinessProbe(
  probe: () => Promise<unknown>,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Readiness probe timed out.")),
          timeoutMs,
        );
      }),
    ]);

    return true;
  } catch {
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function buildHealthHeaders(correlationId: string) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "X-Correlation-ID": correlationId,
    "X-Robots-Tag": "noindex, noarchive",
  };
}

