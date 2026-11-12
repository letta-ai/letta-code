import { describe, expect, spyOn, test } from "bun:test";
import { buildEphemeralConversationCreateBody } from "@/agent/ephemeral-conversation";
import { getBackend } from "@/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

describe("ephemeral conversation parent budget isolation", () => {
  test.each([
    {
      name: "same-model conversation override",
      parentModel: "openai/gpt-5.6-luna",
      conversation: {
        model: "openai/gpt-5.6-luna",
        model_settings: {
          max_output_tokens: 24000,
          reasoning_effort: "low",
          temperature: 0.3,
        },
        context_window_limit: 256000,
      },
      context: 256000,
      output: 24000,
    },
    {
      name: "unpinned conversation inherits legacy agent defaults",
      parentModel: "openai/gpt-5.6-luna",
      conversation: {
        model: null,
        model_settings: null,
        context_window_limit: null,
      },
      context: 192000,
      output: 16000,
    },
    {
      name: "different model retains catalog defaults",
      parentModel: "anthropic/claude-sonnet-5",
      conversation: null,
      context: 350000,
      output: 128000,
    },
  ])("$name", async ({ parentModel, conversation, context, output }) => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: parentModel,
      llm_config: { max_tokens: 16000, context_window: 192000 },
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    const lookup = spyOn(backend, "retrieveConversation").mockResolvedValue({
      id: "conv-parent",
      agent_id: "agent-parent",
      ...conversation,
    } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
    try {
      const body = await buildEphemeralConversationCreateBody(
        { model: "gpt-5.6-luna", systemPromptCustom: "probe" },
        {
          LETTA_CODE_AGENT_ROLE: "subagent",
          LETTA_PARENT_AGENT_ID: "agent-parent",
          ...(conversation
            ? { LETTA_PARENT_CONVERSATION_ID: "conv-parent" }
            : {}),
        },
      );
      expect(body.context_window_limit).toBe(context);
      expect(body.model_settings?.max_output_tokens).toBe(output);
      expect(body.model_settings?.reasoning_effort).toBe("high");
      expect(body.model_settings?.temperature).toBeUndefined();
    } finally {
      lookup.mockRestore();
      agent.mockRestore();
    }
  });
});
