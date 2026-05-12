import { describe, expect, test } from "bun:test";
import { getInternalToolName, getServerToolName } from "../../tools/manager";

describe("Task → Agent server-name mapping", () => {
  test("server-facing name for Task is Agent", () => {
    expect(getServerToolName("Task")).toBe("Agent");
  });

  test("model-visible 'Agent' resolves back to internal 'Task'", () => {
    expect(getInternalToolName("Agent")).toBe("Task");
  });

  test("pass-through names are unchanged", () => {
    expect(getServerToolName("Bash")).toBe("Bash");
    expect(getInternalToolName("Bash")).toBe("Bash");
    expect(getServerToolName("Read")).toBe("Read");
    expect(getInternalToolName("Read")).toBe("Read");
  });

  test("non-mapped internal names round-trip through getInternalToolName", () => {
    // Unknown server names are returned as-is so unknown tools don't break.
    expect(getInternalToolName("DoesNotExist")).toBe("DoesNotExist");
  });
});
