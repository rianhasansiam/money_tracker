import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = process.cwd();
const nextDirectory = resolve(projectRoot, ".next");
const artifactRoot = join(nextDirectory, "standalone");
const serverEntry = join(artifactRoot, "server.js");

if (!existsSync(serverEntry)) {
  throw new Error(
    "The standalone runtime artifact is missing. Run the production build before runtime:prune.",
  );
}

function copyRuntimeAsset(source, destination) {
  if (!existsSync(source)) {
    return;
  }

  rmSync(destination, { force: true, recursive: true });
  cpSync(source, destination, { force: true, recursive: true });
}

function removePrismaTooling(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = join(directory, entry.name);

    if (entry.name === "node_modules") {
      rmSync(join(entryPath, "prisma"), { force: true, recursive: true });
      rmSync(join(entryPath, "@prisma", "dev"), {
        force: true,
        recursive: true,
      });
    }

    if (existsSync(entryPath)) {
      removePrismaTooling(entryPath);
    }
  }
}

copyRuntimeAsset(
  join(nextDirectory, "static"),
  join(artifactRoot, ".next", "static"),
);
copyRuntimeAsset(join(projectRoot, "public"), join(artifactRoot, "public"));
removePrismaTooling(artifactRoot);

console.log("Prepared the traced standalone runtime artifact.");
