import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("createAgent memory prompt wiring", () => {
  test("treats custom system prompts as complete prompts", () => {
    const createPath = fileURLToPath(
      new URL("../../agent/create.ts", import.meta.url),
    );
    const source = readFileSync(createPath, "utf-8");

    expect(source).toContain("options.systemPromptCustom");
    expect(source).not.toContain("disableManagedMemoryPrompt");
    expect(source).not.toContain("swapMemoryAddon");
  });
});
