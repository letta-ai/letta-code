import { describe, expect, test } from "bun:test";
import { isMemoryTool } from "../../cli/helpers/toolNameMapping";

describe("toolNameMapping.isMemoryTool", () => {
  test("recognizes all supported memory tool names", () => {
    expect(isMemoryTool("memory")).toBe(true);
    expect(isMemoryTool("memory_apply_patch")).toBe(true);
    expect(isMemoryTool("memory_insert")).toBe(true);
    expect(isMemoryTool("memory_replace")).toBe(true);
    expect(isMemoryTool("memory_rethink")).toBe(true);
  });

  test("returns false for non-memory tools", () => {
    expect(isMemoryTool("bash")).toBe(false);
    expect(isMemoryTool("web_search")).toBe(false);
  });
});
