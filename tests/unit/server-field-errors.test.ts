import { describe, expect, it, vi } from "vitest";
import type { UseFormSetError } from "react-hook-form";
import { applyServerFieldErrors } from "@/lib/server-field-errors";

interface ExampleFormValues {
  amount: string;
  note: string;
}

describe("server field error mapping", () => {
  it("maps defined messages to React Hook Form server errors", () => {
    const setError = vi.fn() as unknown as UseFormSetError<ExampleFormValues>;

    applyServerFieldErrors(setError, {
      amount: "Enter a supported amount.",
      note: undefined,
    });

    expect(setError).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenCalledWith("amount", {
      type: "server",
      message: "Enter a supported amount.",
    });
  });
});
