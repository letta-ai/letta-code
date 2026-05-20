#!/usr/bin/env node
/**
 * Updates import paths after renaming .ts files to kebab-case.
 *
 * Builds an exact old-basename → new-basename mapping from `git diff --cached`
 * so only paths that were actually renamed get updated.
 * .tsx component imports are NOT touched (those files weren't renamed).
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Build exact mapping from git staged renames: oldBase -> newBase (no extension)
const renameMap = new Map(); // "OldName" -> "new-name"

const gitStatus = execSync("git diff --cached --name-status", {
  encoding: "utf-8",
});

for (const line of gitStatus.split("\n")) {
  const m = line.match(/^R\d*\t(.+)\t(.+)$/);
  if (!m) continue;
  const [, oldPath, newPath] = m;
  const oldBase = basename(oldPath);
  const newBase = basename(newPath);
  if (oldBase === newBase) continue;

  // Strip only the last extension (e.g. "FooBar.shared.ts" -> "FooBar.shared")
  // so dotted names like imageResize.shared are looked up correctly.
  const oldStem = oldBase.replace(/\.[^.]+$/, "");
  const newStem = newBase.replace(/\.[^.]+$/, "");
  renameMap.set(oldStem, newStem);
}

console.log(`Built rename map: ${renameMap.size} entries`);

function* walkSrc(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkSrc(full);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
  }
}

// Replace the last path segment of an import path if it's in the rename map
function updatePath(importPath) {
  const lastSlash = importPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? importPath.slice(0, lastSlash + 1) : "";
  let file = lastSlash >= 0 ? importPath.slice(lastSlash + 1) : importPath;

  // Strip explicit .ts/.js extension for lookup (imports usually have no ext)
  let ext = "";
  if (file.endsWith(".ts") || file.endsWith(".js")) {
    ext = file.slice(file.lastIndexOf("."));
    file = file.slice(0, file.lastIndexOf("."));
  }

  const newFile = renameMap.get(file);
  if (!newFile) return importPath;
  return dir + newFile + ext;
}

let totalFiles = 0;
let totalChanged = 0;

// Matches from/import()/require() string literals and new URL() path strings
const IMPORT_RE =
  /(?:(?:from|import)\s*\(?\s*|require\s*\()(["'`])([^"'`\n]+)\1/g;
const URL_RE = /new\s+URL\s*\(\s*(["'`])([^"'`\n]+\.ts)\1/g;

for (const file of walkSrc("src")) {
  const src = readFileSync(file, "utf-8");
  let result = src;

  result = result.replace(IMPORT_RE, (match, quote, path) => {
    const updated = updatePath(path);
    return updated === path ? match : match.replace(path, updated);
  });

  result = result.replace(URL_RE, (match, quote, path) => {
    const updated = updatePath(path);
    return updated === path ? match : match.replace(path, updated);
  });

  if (result !== src) {
    writeFileSync(file, result, "utf-8");
    totalChanged++;
  }
  totalFiles++;
}

console.log(`Scanned ${totalFiles} files, updated ${totalChanged} files.`);
