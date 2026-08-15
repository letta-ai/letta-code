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

  test("builds codex tools for custom OpenAI provider handles", async () => {
    for (const providerType of ["chatgpt_oauth", "openai-codex"]) {
      const prepared = await prepareToolExecutionContextForResolvedTarget({
        modelIdentifier: "custom/gpt-5.6-sol",
        providerType,
        toolsetPreference: "auto",
      });

      expect(prepared.toolset).toBe("codex");
      expect(prepared.preparedToolContext.loadedToolNames).toContain(
        "ApplyPatch",
      );
      expect(prepared.preparedToolContext.loadedToolNames).toContain(
        "exec_command",
      );
      expect(prepared.preparedToolContext.loadedToolNames).not.toContain(
        "Edit",
      );
    }
  });

  test("keeps custom non-OpenAI provider handles on default tools", async () => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "custom/claude-sonnet-5",
      providerType: "anthropic",
      toolsetPreference: "auto",
    });

    expect(prepared.toolset).toBe("default");
    expect(prepared.preparedToolContext.loadedToolNames).toContain("Edit");
    expect(prepared.preparedToolContext.loadedToolNames).not.toContain(
      "ApplyPatch",
    );
  });

  test("loads bundled tools named only in the allowlist", async () => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
      clientToolAllowlist: ["Read", "LS", "Glob", "Grep"],
    });

    // LS, Glob and Grep are not in the default base; allowlisting them is
    // what loads them.
    expect([...prepared.preparedToolContext.loadedToolNames].sort()).toEqual([
      "Glob",
      "Grep",
      "LS",
      "Read",
    ]);
  });

  test("ignores allowlist entries that are not bundled client tools", async () => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
      clientToolAllowlist: ["Read", "mcp__files__read", "SomeCustomTool"],
    });

    expect(prepared.preparedToolContext.loadedToolNames).toEqual(["Read"]);
  });

  test("does not leak one turn's tools into the next", async () => {
    await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
      clientToolset: { include: ["Glob"] },
    });

    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-sonnet-5",
      toolsetPreference: "auto",
    });

    expect(prepared.preparedToolContext.loadedToolNames).not.toContain("Glob");
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
