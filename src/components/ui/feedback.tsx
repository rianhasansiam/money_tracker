import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Feedback({ children, tone = "info", className }: { children: ReactNode; tone?: "info" | "error" | "warning"; className?: string }) {
  return <div role={tone === "info" ? "status" : "alert"} className={cn("rounded-lg border p-3 text-sm leading-6", {
    info: "border-border bg-muted text-muted-foreground",
    error: "border-red-200 bg-red-50 text-destructive",
    warning: "border-amber-200 bg-amber-50 text-warning",
  }[tone], className)}>{children}</div>;
}
