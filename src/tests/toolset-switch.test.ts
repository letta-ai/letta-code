import { describe, expect, test } from "bun:test";
import { getClient } from "../agent/client";
import { createAgent } from "../agent/create";
import { models } from "../agent/model";
import { updateAgentLLMConfig } from "../agent/modify";
import { settingsManager } from "../settings-manager";
import {
  clearTools,
  getToolNames,
  loadTools,
  upsertToolsToServer,
} from "../tools/manager";
import { BASE_TOOL_NAMES, switchToolsetForModel } from "../tools/toolset";

// Skip these integration tests if LETTA_API_KEY is not set
const shouldSkip = !process.env.LETTA_API_KEY;
const describeOrSkip = shouldSkip ? describe.skip : describe;

describeOrSkip("toolset switching preserves base tools (TUI flow)", () => {
  test(
    "TUI-style model change swaps Letta toolset and keeps base tools",
    async () => {
      const apiKey = process.env.LETTA_API_KEY || "";
      if (!apiKey) return; // Extra safety, though test should be skipped

      await settingsManager.initialize();
      settingsManager.updateSettings({
        env: {
          ...(settingsManager.getSettings().env || {}),
          LETTA_API_KEY: apiKey,
        },
      });

      const client = await getClient();

      // --- Step 1: mimic interactive TUI startup ---
      // LoadingApp.init() calls loadTools(model) with model possibly undefined,
      // which results in the Anthropic default toolset being loaded, then
      // upserts those tools before creating the agent.
      clearTools();
      await loadTools(); // default Anthropic toolset
      const anthropicToolset = new Set(getToolNames());
      await upsertToolsToServer(client);

      // Create an agent via the same helper used by the TUI. This mirrors the
      // default Sonnet agent creation path (no explicit model override).
      const agent = await createAgent("toolset-switch-test");
      const agentId = agent.id;

      try {
        // --- Step 2: mimic /model selection in the TUI ---
        // handleModelSelect() looks up the selected model from models.json and
        // calls updateAgentLLMConfig(...) followed by switchToolsetForModel(...)
        // with the model handle.
        const codexModelInfo =
          models.find((m) => m.handle === "openai/gpt-5.1-codex") ??
          models.find((m) => m.handle.startsWith("openai/gpt-5.1-codex"));

        if (!codexModelInfo) {
          throw new Error(
            "Codex model handle openai/gpt-5.1-codex not found in models.json",
          );
        }

        const codexHandle = codexModelInfo.handle;

        await updateAgentLLMConfig(
          agentId,
          codexHandle,
          codexModelInfo.updateArgs,
        );

        clearTools();
        const toolsetName = await switchToolsetForModel(codexHandle, agentId);
        expect(toolsetName).toBe("codex");

        const codexToolset = new Set(getToolNames());

        const afterCodex = await client.agents.retrieve(agentId, {
          include: ["agent.tools"],
        });
        const codexToolNames = new Set(
          (afterCodex.tools || [])
            .map((t) => t.name)
            .filter((n): n is string => typeof n === "string"),
        );

        // Base tools must always be present
        for (const name of BASE_TOOL_NAMES) {
          expect(codexToolNames.has(name)).toBe(true);
        }

        // All Codex Letta tools must be present
        for (const name of codexToolset) {
          expect(codexToolNames.has(name)).toBe(true);
        }

        // Anthropic-only Letta tools (non-base) should have been removed
        anthropicToolset.forEach((name) => {
          if (!BASE_TOOL_NAMES.includes(name)) {
            expect(codexToolNames.has(name)).toBe(false);
          }
        });
      } finally {
        await client.agents.delete(agentId);
      }
    },
    { timeout: 90000 },
  );
});
