import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { ModToolEndEvent } from "@/mods/types";
import {
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  clearTools,
  executeTool,
  getToolNames,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
  registerExternalTools,
} from "@/tools/manager";

describe("tool_end result delivery", () => {
  let initialTools: string[] = [];

  beforeAll(() => {
    initialTools = getToolNames();
  });

  afterEach(() => {
    clearCapturedToolExecutionContexts();
    clearExternalTools();
  });

  afterAll(async () => {
    if (initialTools.length > 0) {
      await loadSpecificTools(initialTools);
    } else {
      clearTools();
    }
  });

  test("emits tool_end for a Bash structured text result", async () => {
    await loadSpecificTools(["Bash"]);
    const endEvents: ModToolEndEvent[] = [];
    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, event) {
          if (name === "tool_end") {
            const toolEndEvent = event as ModToolEndEvent & {
              result?: { status: "success" | "error"; output: string };
            };
            endEvents.push(toolEndEvent);
            toolEndEvent.result = {
              status: "success",
              output: "rewritten by mod",
            };
          }
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
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]?.output).toContain("tool-end-repro");
    expect(result.toolReturn).toBe("rewritten by mod");
  });

  test("does not emit tool_end for a result containing an image", async () => {
    registerExternalTools([
      {
        name: "ScreenshotTool",
        description: "Return a screenshot",
        parameters: { type: "object", properties: {} },
        executor: async () => ({
          content: [
            { type: "text", text: "Desktop screenshot" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          isError: false,
        }),
      },
    ]);
    let endEventCount = 0;
    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, _event) {
          if (name === "tool_end") endEventCount += 1;
          return { diagnostics: [], handlerCount: 0, name, results: [] };
        },
      },
    });

    const result = await executeTool(
      "ScreenshotTool",
      {},
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(result.toolReturn).toEqual([
      { type: "text", text: "Desktop screenshot" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
    ]);
    expect(endEventCount).toBe(0);
  });
});
