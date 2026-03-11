import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LETTAIGNORE = `\
# .lettaignore — Letta Code file index exclusions
#
# Files and directories matching these patterns are excluded from the @ file
# search index (cache). They won't appear in autocomplete results by default,
# but can still be found if you type their path explicitly.
#
# Syntax: one pattern per line, supports globs (e.g. *.log, src/generated/**)
# Lines starting with # are comments.
#
# The following are always excluded (even from explicit search) and do not need
# to be listed here:
#   node_modules  dist  build  out  coverage  target  bower_components
#   .git  .cache  .next  .nuxt  venv  .venv  __pycache__  .tox

# Lock files
package-lock.json
yarn.lock
pnpm-lock.yaml
poetry.lock
Cargo.lock

# Logs
*.log

# OS artifacts
.DS_Store
Thumbs.db
`;

/**
 * Create a .lettaignore file in the project root with sensible defaults
 * if one does not already exist. Safe to call multiple times.
 */
export function ensureLettaIgnoreFile(cwd: string = process.cwd()): void {
  const filePath = join(cwd, ".lettaignore");
  if (existsSync(filePath)) return;

  try {
    writeFileSync(filePath, DEFAULT_LETTAIGNORE, "utf-8");
  } catch {
    // If we can't write (e.g. read-only fs), silently skip — the
    // hardcoded defaults in fileSearchConfig.ts still apply.
  }
}

/**
 * Read glob patterns from a .lettaignore file in the given directory.
 * Returns an empty array if the file is missing or unreadable.
 *
 * Syntax:
 *   - One pattern per line (supports globs: *.log, src/generated/**)
 *   - Lines starting with # are comments
 *   - Negations (!) are not currently supported and are silently skipped
 *   - A trailing / is treated as a directory hint and stripped before matching
 */
export function readLettaIgnorePatterns(cwd: string = process.cwd()): string[] {
  const filePath = join(cwd, ".lettaignore");
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
