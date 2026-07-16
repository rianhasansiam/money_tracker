import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

const artifactRoot = resolve(process.cwd(), ".next", "standalone");
const serverEntry = join(artifactRoot, "server.js");

if (!existsSync(serverEntry)) {
  throw new Error(
    "The standalone runtime artifact is missing. Run npm run build before runtime:verify.",
  );
}

const forbiddenDirectories = [];

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = join(directory, entry.name);

    if (entry.name === "node_modules") {
      const prismaCli = join(entryPath, "prisma");
      const prismaDev = join(entryPath, "@prisma", "dev");

      if (existsSync(prismaCli)) {
        forbiddenDirectories.push(prismaCli);
      }

      if (existsSync(prismaDev)) {
        forbiddenDirectories.push(prismaDev);
      }
    }

    inspect(entryPath);
  }
}

inspect(artifactRoot);

if (forbiddenDirectories.length > 0) {
  const paths = forbiddenDirectories
    .map((path) => relative(artifactRoot, path))
    .join(", ");
  throw new Error(`Prisma CLI/tooling remains in the runtime artifact: ${paths}`);
}

const runtimeRequire = createRequire(serverEntry);
const requiredRuntimePackages = [
  "next",
  "@prisma/client",
  "@prisma/adapter-pg",
  "pg",
];

for (const packageName of requiredRuntimePackages) {
  const resolvedPackage = runtimeRequire.resolve(packageName);
  const artifactRelativePath = relative(artifactRoot, resolvedPackage);

  if (
    artifactRelativePath.startsWith("..") ||
    isAbsolute(artifactRelativePath)
  ) {
    throw new Error(
      `Required runtime package resolved outside the standalone artifact: ${packageName}`,
    );
  }
}

const generatedClient = join(
  artifactRoot,
  "node_modules",
  ".prisma",
  "client",
);

if (!existsSync(generatedClient)) {
  throw new Error("The generated Prisma Client is missing from the runtime artifact.");
}

console.log(
  "Runtime artifact verified: Prisma CLI/tooling absent and required database runtime packages present.",
);
