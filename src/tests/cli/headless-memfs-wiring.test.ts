import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless memfs wiring", () => {
  test("new-agent memfs sync skips prompt rewrite", () => {
    const headlessPath = fileURLToPath(
      new URL("../../headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    const matches = source.match(/skipPromptUpdate:\s*forceNew/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
