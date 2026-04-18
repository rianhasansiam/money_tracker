"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "glass-panel border border-white/70 !rounded-3xl !bg-white/90 !text-foreground",
          title: "!text-foreground !font-semibold",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-muted !text-foreground",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
