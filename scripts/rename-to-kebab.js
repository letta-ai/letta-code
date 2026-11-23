#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function toKebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

const renames = [];

for (const file of walkTs("src")) {
  const dir = dirname(file);
  const filename = basename(file);
  const dotIdx = filename.indexOf(".");
  const base = filename.slice(0, dotIdx);
  const ext = filename.slice(dotIdx);
  const kebab = toKebab(base);
  if (kebab !== base) {
    const newFilename = kebab + ext;
    const newFile = join(dir, newFilename);
    renames.push({ from: file, to: newFile });
  }
}

console.log(`Found ${renames.length} files to rename.\n`);

for (const { from, to } of renames) {
  if (existsSync(to)) {
    console.warn(`SKIP (target exists): ${from} -> ${to}`);
    continue;
  }
  execSync(`git mv "${from}" "${to}"`, { stdio: "inherit" });
}

console.log(`\nDone. ${renames.length} files renamed.`);
console.log("\nNext: run the import update script to fix all references.");
