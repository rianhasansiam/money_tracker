import { db } from "@/lib/db";
import { buildHealthHeaders, runReadinessProbe } from "@/lib/health";
import {
  createCorrelationId,
  logServerEvent,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const correlationId = createCorrelationId();
  const isReady = await runReadinessProbe(async () => {
    await db.$queryRaw`SELECT 1`;
  });

  if (!isReady) {
    logServerEvent(
      "warn",
      SERVER_ERROR_CATEGORY.dependencyUnavailable,
      "readiness_check_failed",
      { correlationId },
    );
  }

  return Response.json(
    { status: isReady ? "ready" : "unavailable" },
    {
      status: isReady ? 200 : 503,
      headers: buildHealthHeaders(correlationId),
    },
  );
}

