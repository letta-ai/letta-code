import { afterEach, describe, expect, test } from "bun:test";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";

describe("request-scoped client toolsets", () => {
  afterEach(() => {
    clearCapturedToolExecutionContexts();
  });

  test("builds an exact read-only toolset from a none base", async () => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
      clientToolset: {
        base: "none",
        include: ["Read", "LS", "Glob", "Grep"],
      },
      clientToolAllowlist: ["Read", "LS", "Glob", "Grep"],
    });

    expect(prepared.toolset).toBe("none");
    expect(prepared.toolsetPreference).toBe("auto");
    expect(prepared.preparedToolContext.loadedToolNames).toEqual([
      "Read",
      "LS",
      "Glob",
      "Grep",
    ]);
    expect(
      prepared.preparedToolContext.clientTools.map((tool) => tool.name),
    ).toEqual(["Read", "LS", "Glob", "Grep"]);
  });

  test("applies exclusions after additive tool includes", async () => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
      clientToolset: { include: ["AskUserQuestion"] },
      exclude: ["AskUserQuestion"],
      clientToolAllowlist: ["Read", "AskUserQuestion"],
    });

    expect(prepared.preparedToolContext.loadedToolNames).toEqual(["Read"]);
  });

  test("rejects unknown bundled tool names", async () => {
    expect(
      prepareToolExecutionContextForResolvedTarget({
        modelIdentifier: "anthropic/claude-sonnet-5",
        toolsetPreference: "auto",
        clientToolset: { include: ["NotABundledTool"] },
      }),
    ).rejects.toThrow("Unknown bundled client tool: NotABundledTool");
  });
});
