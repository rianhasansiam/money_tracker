import { describe, expect, it, vi } from "vitest";
import { runPostCommitTasks } from "@/lib/post-commit";

describe("runPostCommitTasks", () => {
  it("reports success after all presentation tasks complete", () => {
    expect(runPostCommitTasks([vi.fn(), vi.fn()])).toBe(true);
  });

  it("reports presentation failure without throwing or skipping later tasks", () => {
    const laterTask = vi.fn();

    expect(
      runPostCommitTasks([
        () => {
          throw new Error("Cache unavailable");
        },
        laterTask,
      ]),
    ).toBe(false);
    expect(laterTask).toHaveBeenCalledTimes(1);
  });
});
