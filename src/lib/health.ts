export function buildHealthHeaders(correlationId: string) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "X-Correlation-ID": correlationId,
    "X-Robots-Tag": "noindex, noarchive",
  };
}

