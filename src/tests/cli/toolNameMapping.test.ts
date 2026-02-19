import { describe, expect, test } from "bun:test";
import {
  getDisplayToolName,
  isMemoryTool,
  isShellOutputTool,
} from "../../cli/helpers/toolNameMapping";

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

describe("toolNameMapping task output mappings", () => {
  test("uses distinct display labels for shell output and task output", () => {
    expect(getDisplayToolName("BashOutput")).toBe("Shell Output");
    expect(getDisplayToolName("TaskOutput")).toBe("Task Output");
  });

  test("treats TaskOutput as shell-style output for streaming UI", () => {
    expect(isShellOutputTool("TaskOutput")).toBe(true);
    expect(isShellOutputTool("BashOutput")).toBe(true);
    expect(isShellOutputTool("Task")).toBe(false);
  });
});
