import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("block min-w-0 text-sm font-medium leading-6 text-foreground wrap-anywhere", className)}
      {...props}
    />
  );
}

export { Label };
