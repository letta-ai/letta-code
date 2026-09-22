import { describe, expect, test } from "bun:test";
import {
  getDisplayToolName,
  isMemoryTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";

describe("toolNameMapping display mappings", () => {
  test("maps memory tools to one friendly label", () => {
    expect(getDisplayToolName("memory")).toBe("Memory");
    expect(getDisplayToolName("memory_apply_patch")).toBe("Memory");
  });

  test("maps web search tools to friendly labels", () => {
    expect(getDisplayToolName("web_search")).toBe("Web Search");
    expect(getDisplayToolName("WebSearch")).toBe("Web Search");
  });
});

describe("toolNameMapping.isMemoryTool", () => {
  test("recognizes all supported memory tool names", () => {
    expect(isMemoryTool("memory")).toBe(true);
    expect(isMemoryTool("memory_apply_patch")).toBe(true);
  });

  test("returns false for non-memory tools", () => {
    expect(isMemoryTool("bash")).toBe(false);
    expect(isMemoryTool("web_search")).toBe(false);
  });
});

describe("toolNameMapping task aliases", () => {
  test("treats Agent as a task/subagent tool for TUI rendering", () => {
    expect(isTaskTool("Task")).toBe(true);
    expect(isTaskTool("task")).toBe(true);
    expect(isTaskTool("Agent")).toBe(true);
    expect(isTaskTool("agent")).toBe(true);
    expect(isTaskTool("TaskStop")).toBe(false);
  });
});
