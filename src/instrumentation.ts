import type { Instrumentation } from "next";
import {
  logServerError,
  logServerEvent,
  SERVER_ERROR_CATEGORY,
} from "@/lib/observability";

export function register() {
  logServerEvent(
    "info",
    SERVER_ERROR_CATEGORY.configuration,
    "server_instance_started",
    {
      context: {
        runtime: process.env.NEXT_RUNTIME ?? "nodejs",
      },
    },
  );
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  logServerError(SERVER_ERROR_CATEGORY.unexpected, error, {
    context: {
      method: request.method,
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason,
    },
  });
};
