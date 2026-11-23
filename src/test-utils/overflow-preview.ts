import { expect } from "bun:test";
import { LIMITS } from "@/tools/impl/truncation";

const OVERFLOW_PATH_PATTERN = /\[Full output written to: (.+?\.txt)\]/;

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

export function expectOverflowPath(text: string): string {
  const overflowPath = text.match(OVERFLOW_PATH_PATTERN)?.[1];
  if (!overflowPath) {
    throw new Error("Expected output to name a saved overflow file");
  }
  return overflowPath;
}
