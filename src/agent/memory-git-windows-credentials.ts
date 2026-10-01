import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Escape whitespace in an absolute Git credential-helper command path. */
export function formatGitCredentialHelperPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\s/g, "\\$&");
}

/** Write in staging, but configure Git to find the helper after publication. */
export function writeWindowsCredentialHelper(
  directory: string,
  token: string,
  publishedDirectory = directory,
): string {
  const helperScriptPath = join(
    directory,
    ".git",
    "letta-credential-helper.cmd",
  );
  writeFileSync(
    helperScriptPath,
    `@echo off\necho username=letta\necho password=${token}\n`,
    "utf8",
  );
  return formatGitCredentialHelperPath(
    join(publishedDirectory, ".git", "letta-credential-helper.cmd"),
  );
}
