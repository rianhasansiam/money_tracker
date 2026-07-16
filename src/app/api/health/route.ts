import { buildHealthHeaders } from "@/lib/health";
import { createCorrelationId } from "@/lib/observability";

export const dynamic = "force-dynamic";

export function GET() {
  const correlationId = createCorrelationId();

  return Response.json(
    { status: "ok" },
    {
      status: 200,
      headers: buildHealthHeaders(correlationId),
    },
  );
}

