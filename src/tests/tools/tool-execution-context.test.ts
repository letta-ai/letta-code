import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  captureToolExecutionContext,
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  clearTools,
  executeTool,
  getToolNames,
  loadSpecificTools,
  prepareToolExecutionContextForSpecificTools,
} from "../../tools/manager";

function asText(
  toolReturn: Awaited<ReturnType<typeof executeTool>>["toolReturn"],
) {
  return typeof toolReturn === "string"
    ? toolReturn
    : JSON.stringify(toolReturn);
}

describe("tool execution context snapshot", () => {
  let initialTools: string[] = [];

  beforeAll(() => {
    initialTools = getToolNames();
  });

  afterAll(async () => {
    clearCapturedToolExecutionContexts();
    clearExternalTools();
    if (initialTools.length > 0) {
      await loadSpecificTools(initialTools);
    } else {
      clearTools();
    }
  });

  test("executes Read using captured context after global toolset changes", async () => {
    await loadSpecificTools(["Read"]);
    const { contextId } = captureToolExecutionContext();

    await loadSpecificTools(["ReadFile"]);

    const withoutContext = await executeTool("Read", {
      file_path: "README.md",
    });
    expect(withoutContext.status).toBe("error");
    expect(asText(withoutContext.toolReturn)).toContain("Tool not found: Read");

    const withContext = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: contextId },
    );
    expect(withContext.status).toBe("success");
  });

  test("executes ReadFile using captured context after global toolset changes", async () => {
    await loadSpecificTools(["ReadFile"]);
    const { contextId } = captureToolExecutionContext();

    await loadSpecificTools(["Read"]);

    const withoutContext = await executeTool("ReadFile", {
      file_path: "README.md",
    });
    expect(withoutContext.status).toBe("error");
    expect(asText(withoutContext.toolReturn)).toContain(
      "Tool not found: ReadFile",
    );

    const withContext = await executeTool(
      "ReadFile",
      { file_path: "README.md" },
      { toolContextId: contextId },
    );
    expect(withContext.status).toBe("success");
  });

  test("prepares explicit tool snapshots without reading the global registry", async () => {
    await loadSpecificTools(["Edit"]);

    const prepared = await prepareToolExecutionContextForSpecificTools([
      "Read",
    ]);

    expect(prepared.loadedToolNames).toContain("Read");
    expect(prepared.loadedToolNames).not.toContain("Edit");

    const withPreparedContext = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    expect(withPreparedContext.status).toBe("success");
  });
});
