import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PostgreSQL suites intentionally share one disposable database. Running
    // their per-file cleanup concurrently would make otherwise deterministic
    // authorization and E2E fixtures race each other.
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
