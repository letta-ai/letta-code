#!/usr/bin/env node
/**
 * Enforces kebab-case filenames for .ts files in src/.
 * .tsx files are exempt — PascalCase is the React component convention.
 * .d.ts files are exempt.
 *
 * A filename is a violation if its stem (before the first dot) contains
 * any uppercase letter, e.g. bootstrapHandler.ts or LocalStore.ts.
 *
 * Pass --staged to check only git-staged files (used in pre-commit hook).
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const stagedOnly = process.argv.includes("--staged");

function isViolation(filename) {
  if (!filename.endsWith(".ts")) return false;
  if (filename.endsWith(".d.ts")) return false;
  const stem = filename.slice(0, filename.indexOf("."));
  return /[A-Z]/.test(stem);
}

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (isViolation(entry)) yield full;
  }
}

let files;

if (stagedOnly) {
  const staged = execSync("git diff --cached --name-only --diff-filter=A", {
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter((f) => f.startsWith("src/") && isViolation(basename(f)));
  files = staged;
} else {
  files = [...walkTs("src")];
}

if (files.length === 0) {
  console.log("✅ No filename casing violations found.");
  process.exit(0);
}

console.error("\n❌ Non-kebab-case .ts filenames found:\n");
for (const f of files) {
  const stem = basename(f).slice(0, basename(f).indexOf("."));
  const kebab = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  console.error(`  ${f}`);
  console.error(`    ↳ rename to: ${basename(f).replace(stem, kebab)}\n`);
}

console.error(
  `Found ${files.length} violation${files.length === 1 ? "" : "s"}.`,
);
console.error(
  ".tsx files are exempt (PascalCase is correct for React components).\n",
);
process.exit(1);
