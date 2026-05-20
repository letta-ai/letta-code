#!/usr/bin/env node

const { readdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, "src");

function collectTests(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(repoRoot, fullPath) === "src/integration-tests") continue;
      collectTests(fullPath, out);
      continue;
    }

    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      out.push(relative(repoRoot, fullPath));
    }
  }
}

const testFiles = [];
collectTests(srcRoot, testFiles);
testFiles.sort();

if (testFiles.length === 0) {
  console.error("No unit test files found under src/");
  process.exit(1);
}

const result = spawnSync(
  "bun",
  ["test", ...testFiles, "--timeout", "15000"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
