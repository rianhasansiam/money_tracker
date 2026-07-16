import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const omittedDependencyTypes = new Set(
  (process.env.npm_config_omit ?? "")
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean),
);

if (
  omittedDependencyTypes.has("dev") ||
  process.env.npm_config_production === "true"
) {
  console.log(
    "Skipping Prisma Client generation for this production-only runtime install.",
  );
  process.exit(0);
}

let prismaCliPath;

try {
  prismaCliPath = require.resolve("prisma/build/index.js", {
    paths: [process.cwd()],
  });
} catch (error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND"
  ) {
    console.log(
      "Prisma CLI is not installed; skipping generation for this production-only runtime install.",
    );
    process.exit(0);
  }

  throw error;
}

const result = spawnSync(process.execPath, [prismaCliPath, "generate"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
