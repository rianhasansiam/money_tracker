import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedMatchers = [
  "/dashboard/:path*",
  "/groups/:path*",
  "/admin/:path*",
];
const manifestPath = resolve(
  process.cwd(),
  ".next/server/functions-config-manifest.json",
);

let manifest;

try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  throw new Error(
    "The Next.js function configuration manifest is missing or invalid. Run a production build first.",
  );
}

const proxyConfiguration = manifest?.functions?.["/_middleware"];
const actualMatchers = Array.isArray(proxyConfiguration?.matchers)
  ? proxyConfiguration.matchers.map((matcher) => matcher?.originalSource)
  : [];

if (
  actualMatchers.length !== expectedMatchers.length ||
  expectedMatchers.some((matcher) => !actualMatchers.includes(matcher))
) {
  throw new Error("The compiled Proxy matcher set is incomplete.");
}

process.stdout.write(
  `Proxy manifest verified (${expectedMatchers.length} protected route families).\n`,
);
