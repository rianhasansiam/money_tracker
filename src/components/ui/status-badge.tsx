import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "positive" | "warning" | "danger" }) {
  return <span className={cn("inline-flex w-fit items-center rounded-md px-2 py-1 text-xs font-semibold", {
    neutral: "bg-muted text-muted-foreground", positive: "bg-green-50 text-positive",
    warning: "bg-amber-50 text-warning", danger: "bg-red-50 text-destructive",
  }[tone])}>{children}</span>;
}
