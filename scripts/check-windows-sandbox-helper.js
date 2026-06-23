#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const repoRoot = process.cwd();
const helperName = "letta-windows-sandbox.exe";
const requiredHelpers = [
  join("vendor", "windows-sandbox", "win32-x64", helperName),
  join("vendor", "windows-sandbox", "win32-arm64", helperName),
];

const missing = requiredHelpers.filter(
  (path) => !existsSync(join(repoRoot, path)),
);
if (missing.length > 0) {
  console.error("Missing Windows sandbox helper binaries:");
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (pack.error || pack.status !== 0) {
  console.error("npm pack --dry-run --json failed");
  if (pack.error) console.error(pack.error.message);
  if (pack.stderr) console.error(pack.stderr.trim());
  process.exit(pack.status ?? 1);
}

let files;
let packageFilename = "npm package";
try {
  const parsed = JSON.parse(pack.stdout);
  packageFilename = parsed?.[0]?.filename ?? packageFilename;
  files = parsed?.[0]?.files?.map((file) => file.path) ?? [];
} catch (error) {
  console.error("Failed to parse npm pack output");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const missingFromPack = requiredHelpers.filter((path) => !files.includes(path));
if (missingFromPack.length > 0) {
  console.error(
    "Windows sandbox helpers exist on disk but are missing from npm pack output:",
  );
  for (const path of missingFromPack) console.error(`  - ${path}`);
  process.exit(1);
}

console.log(
  `Windows sandbox helpers are present and included in ${basename(packageFilename)}`,
);
