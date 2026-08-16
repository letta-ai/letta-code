import { afterAll, describe, expect, test } from "bun:test";
import {
  clearTools,
  executeTool,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
} from "@/tools/manager";

// Regression for #3828: text-only structured tool results (e.g. Bash output
// returned as content parts) must still emit the mod `tool_end` lifecycle
// event. Previously only plain-string returns triggered it.
describe("tool_end for structured text results", () => {
  afterAll(() => {
    clearTools();
  });

  test("emits tool_end for text-only Bash results", async () => {
    await loadSpecificTools(["Bash"]);
    let endEvents = 0;

    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, _event) {
          if (name === "tool_end") endEvents += 1;
          return { diagnostics: [], handlerCount: 0, name, results: [] };
        },
      },
    });

    const result = await executeTool(
      "Bash",
      { command: "echo tool-end-repro" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(endEvents).toBe(1);
  });

  test("emits tool_end for plain-string results", async () => {
    await loadSpecificTools(["Read"]);
    let endEvents = 0;

    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, _event) {
          if (name === "tool_end") endEvents += 1;
          return { diagnostics: [], handlerCount: 0, name, results: [] };
        },
      },
    });

    const result = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(endEvents).toBe(1);
  });
});
