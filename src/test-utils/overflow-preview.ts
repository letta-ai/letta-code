/**
 * Assertions and cleanup for file-backed overflow previews
 * (a short prefix of the output plus the saved file path).
 */

import { expect } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { getOverflowDirectory } from "@/tools/impl/overflow";
import { LIMITS } from "@/tools/impl/truncation";

const OVERFLOW_PATH_PATTERN = /\[Full output written to: (.+?\.txt)\]/;

/**
 * Assert that `text` is a prefix preview of output filled with `fillChar`,
 * and return the saved overflow file path.
 */
export function expectPrefixPreview(text: string, fillChar: string): string {
  expect(text).toStartWith(fillChar.repeat(LIMITS.OVERFLOW_PREVIEW_CHARS));
  expect(text).not.toContain(
    fillChar.repeat(LIMITS.OVERFLOW_PREVIEW_CHARS + 1),
  );
  expect(text).toContain(
    `[Output truncated: showing ${LIMITS.OVERFLOW_PREVIEW_CHARS.toLocaleString()}`,
  );
  return expectOverflowPath(text);
}

/**
 * Assert that `text` names a saved overflow file and return its path.
 */
export function expectOverflowPath(text: string): string {
  const overflowPath = text.match(OVERFLOW_PATH_PATTERN)?.[1];
  if (!overflowPath) {
    throw new Error("Expected output to name a saved overflow file");
  }
  return overflowPath;
}

/**
 * Remove the per-project overflow tree (~/.letta/projects/<project>) that a
 * test's working directory created, not just its agent-tools leaf.
 */
export function removeOverflowProjectDirectory(workingDirectory: string): void {
  rmSync(dirname(getOverflowDirectory(workingDirectory)), {
    recursive: true,
    force: true,
  });
}
