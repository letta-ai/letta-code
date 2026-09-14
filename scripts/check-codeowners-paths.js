#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function hasGlobSyntax(pattern) {
  return /[*?]/.test(pattern);
}

function collectRepositoryPaths(rootDir) {
  const paths = new Set();
  const pending = [rootDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      paths.add(relative(rootDir, entryPath).replaceAll("\\", "/"));
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return paths;
}

function literalPatternExists(repositoryPaths, pattern) {
  const repositoryPath = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!repositoryPath) return true;
  if (repositoryPaths.has(repositoryPath)) return true;

  const isRootRelative =
    pattern.startsWith("/") || repositoryPath.includes("/");
  if (isRootRelative) return false;
  return [...repositoryPaths].some(
    (entry) => entry.split("/").at(-1) === repositoryPath,
  );
}

export function validateCodeownersSource(source, rootDir) {
  const repositoryPaths = collectRepositoryPaths(rootDir);
  const errors = [];
  let checkedLiterals = 0;
  let skippedPatterns = 0;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern] = line.split(/\s+/);
    if (!pattern) continue;
    if (hasGlobSyntax(pattern)) {
      skippedPatterns += 1;
      continue;
    }

    checkedLiterals += 1;
    if (!literalPatternExists(repositoryPaths, pattern)) {
      errors.push({ line: index + 1, pattern });
    }
  }

  return { checkedLiterals, skippedPatterns, errors };
}

function run() {
  const rootDir = process.cwd();
  const codeownersPath = join(rootDir, ".github", "CODEOWNERS");
  const result = validateCodeownersSource(
    readFileSync(codeownersPath, "utf8"),
    rootDir,
  );

  if (result.errors.length > 0) {
    console.error("CODEOWNERS literal path check failed:\n");
    for (const error of result.errors) {
      console.error(
        `  .github/CODEOWNERS:${error.line}: ${error.pattern} does not exist`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Checked ${result.checkedLiterals} literal CODEOWNERS paths (${result.skippedPatterns} glob patterns skipped)`,
  );
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (scriptPath === fileURLToPath(import.meta.url)) run();
