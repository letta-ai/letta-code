import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_LETTAIGNORE = `\
# .lettaignore — Letta Code file index exclusions
#
# Files and directories matching these patterns are excluded from the @ file
# search index and disk scan fallback. Add a pattern per line to opt out of
# indexing; remove or comment a line to bring it back.
#
# Syntax: one pattern per line, supports globs (e.g. *.log, src/generated/**)
# Lines starting with # are comments.
#
# Common patterns (uncomment to enable):
#
# --- Dependency directories ---
# node_modules
# bower_components
# vendor
#
# --- Build outputs ---
# dist
# build
# out
# coverage
# target
# .next
# .nuxt
#
# --- Python ---
# venv
# .venv
# __pycache__
# .tox
#
# --- Version control & tooling ---
# .git
# .cache
#
# --- Lock files ---
# package-lock.json
# yarn.lock
# pnpm-lock.yaml
# poetry.lock
# Cargo.lock
#
# --- Logs ---
# *.log
#
# --- OS artifacts ---
# .DS_Store
# Thumbs.db
`;

/**
 * Create a .lettaignore file in the user's ~/.letta directory with a
 * commented-out template if one does not already exist.
 * All patterns in the generated file are commented out — nothing is excluded
 * by default. Users uncomment the patterns they want.
 */
export function ensureLettaIgnoreFile(homeDir: string = homedir()): void {
  const lettaDir = join(homeDir, ".letta");
  const filePath = join(lettaDir, ".lettaignore");
  if (existsSync(filePath)) return;

  try {
    mkdirSync(lettaDir, { recursive: true });
    writeFileSync(filePath, DEFAULT_LETTAIGNORE, "utf-8");
  } catch {
    // If we can't write (e.g. read-only fs), silently skip.
  }
}

/**
 * Read glob patterns from ~/.letta/.lettaignore.
 * Returns an empty array if the file is missing or unreadable.
 *
 * Syntax:
 *   - One pattern per line (supports globs: *.log, src/generated/**)
 *   - Lines starting with # are comments
 *   - Negations (!) are not currently supported and are silently skipped
 *   - A trailing / is treated as a directory hint and stripped before matching
 */
export function readLettaIgnorePatterns(homeDir: string = homedir()): string[] {
  const filePath = join(homeDir, ".letta", ".lettaignore");
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    return parseLettaIgnore(content);
  } catch {
    return [];
  }
}

function parseLettaIgnore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    );
}
