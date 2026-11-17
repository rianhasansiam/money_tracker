"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TransactionDraftMemoryProvider } from "@/components/dashboard/transaction-draft-memory";

export function Providers({ children }: { children: ReactNode }) {
  const [toastPosition, setToastPosition] = useState<"top-right" | "top-center">(
    "top-right",
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");

    function syncToastPosition(event?: MediaQueryList | MediaQueryListEvent) {
      setToastPosition(event?.matches ?? mediaQuery.matches ? "top-center" : "top-right");
    }

    syncToastPosition(mediaQuery);
    mediaQuery.addEventListener("change", syncToastPosition);

    return () => {
      mediaQuery.removeEventListener("change", syncToastPosition);
    };
  }, []);

  return (
    <TransactionDraftMemoryProvider>
      {children}
      <Toaster position={toastPosition} richColors />
    </TransactionDraftMemoryProvider>
  );
}
