import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("createAgent memory prompt wiring", () => {
  test("skips managed memory addon when initBlocks is explicitly none", () => {
    const createPath = fileURLToPath(
      new URL("../../agent/create.ts", import.meta.url),
    );
    const source = readFileSync(createPath, "utf-8");

    expect(source).toContain("const disableManagedMemoryPrompt");
    expect(source).toContain(
      "options.initBlocks) && options.initBlocks.length === 0",
    );
    expect(source).toContain("resolveSystemPrompt(options.systemPromptPreset)");
  });
});
