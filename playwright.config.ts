import "dotenv/config";
import { defineConfig } from "@playwright/test";

if (!process.env.NODE_ENV) {
  Reflect.set(process.env, "NODE_ENV", "test");
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
