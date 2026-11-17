import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("standalone environment isolation", () => {
  it("prunes copied dotenv files while preserving the source file and runtime entry", () => {
    const root = mkdtempSync(join(tmpdir(), "money-tracker-artifact-test-"));
    try {
      const artifact = join(root, ".next", "standalone");
      mkdirSync(join(artifact, "nested"), { recursive: true });
      writeFileSync(join(root, ".env"), "SYNTHETIC_FIXTURE=keep-source\n");
      writeFileSync(join(artifact, "server.js"), "// runtime fixture\n");
      writeFileSync(join(artifact, ".env"), "SYNTHETIC_FIXTURE=remove-copy\n");
      writeFileSync(join(artifact, "nested", ".env.local"), "SYNTHETIC_FIXTURE=remove-copy\n");
      const verify = spawnSync(process.execPath, [resolve("scripts/verify-runtime-artifact.mjs")], { cwd: root, encoding: "utf8" });
      expect(verify.status).toBe(1);
      expect(verify.stderr).toContain("Private environment files remain");
      const prune = spawnSync(process.execPath, [resolve("scripts/prepare-runtime-artifact.mjs")], { cwd: root, encoding: "utf8" });
      expect(prune.status).toBe(0);
      expect(existsSync(join(artifact, ".env"))).toBe(false);
      expect(existsSync(join(artifact, "nested", ".env.local"))).toBe(false);
      expect(existsSync(join(root, ".env"))).toBe(true);
      expect(existsSync(join(artifact, "server.js"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
