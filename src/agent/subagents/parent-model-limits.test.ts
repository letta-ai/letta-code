import { describe, expect, spyOn, test } from "bun:test";
import { resolveParentModelLimits } from "@/agent/subagents/parent-model-limits";
import { getBackend } from "@/backend";

describe("parent model limits", () => {
  test.each([
    {
      name: "agent defaults for the default conversation",
      conversationId: "default",
      conversation: {},
      expected: {
        model: "openai/parent",
        modelSettings: { max_output_tokens: 16000 },
        contextWindowLimit: 128000,
      },
    },
    {
      name: "a partial same-model conversation override keeps the agent context",
      conversationId: "conv-parent",
      conversation: {
        model: "openai/parent",
        model_settings: { max_output_tokens: 24000 },
      },
      expected: {
        model: "openai/parent",
        modelSettings: { max_output_tokens: 24000 },
        contextWindowLimit: 128000,
      },
    },
    {
      name: "conversation settings can override an inherited model",
      conversationId: "conv-parent",
      conversation: {
        model: null,
        model_settings: { max_output_tokens: 24000 },
        context_window_limit: 256000,
      },
      expected: {
        model: "openai/parent",
        modelSettings: { max_output_tokens: 24000 },
        contextWindowLimit: 256000,
      },
    },
    {
      name: "a different conversation model does not inherit agent budgets",
      conversationId: "conv-parent",
      conversation: { model: "anthropic/other" },
      expected: { model: "anthropic/other" },
    },
    {
      name: "a different conversation model retains only its own pinned budgets",
      conversationId: "conv-parent",
      conversation: {
        model: "anthropic/other",
        model_settings: { max_output_tokens: 4000 },
      },
      expected: {
        model: "anthropic/other",
        modelSettings: { max_output_tokens: 4000 },
      },
    },
    {
      name: "null and invalid conversation limits do not replace valid agent limits",
      conversationId: "conv-parent",
      conversation: {
        model: null,
        model_settings: { max_output_tokens: -1 },
        context_window_limit: null,
      },
      expected: {
        model: "openai/parent",
        modelSettings: { max_output_tokens: 16000 },
        contextWindowLimit: 128000,
      },
    },
  ])("$name", async ({ conversationId, conversation, expected }) => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: "openai/parent",
      model_settings: { max_output_tokens: 16000, temperature: 0.7 },
      context_window_limit: 128000,
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    const lookup = spyOn(backend, "retrieveConversation").mockResolvedValue({
      id: "conv-parent",
      agent_id: "agent-parent",
      ...conversation,
    } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
    try {
      expect(
        await resolveParentModelLimits("agent-parent", conversationId),
      ).toEqual(expected);
      if (conversationId === "default") expect(lookup).not.toHaveBeenCalled();
      else expect(lookup).toHaveBeenCalledWith("conv-parent");
    } finally {
      lookup.mockRestore();
      agent.mockRestore();
    }
  });

  test("unavailable parent settings leave catalog defaults usable", async () => {
    const lookup = spyOn(getBackend(), "retrieveAgent").mockRejectedValue(
      new Error("unavailable"),
    );
    try {
      expect(
        await resolveParentModelLimits("agent-parent", "conv-parent"),
      ).toBeNull();
    } finally {
      lookup.mockRestore();
    }
  });

  test("an unavailable conversation keeps the agent model without guessing its effective budgets", async () => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: "openai/parent",
      model_settings: { max_output_tokens: 16000 },
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    const conversation = spyOn(
      backend,
      "retrieveConversation",
    ).mockRejectedValue(new Error("unavailable"));
    try {
      expect(
        await resolveParentModelLimits("agent-parent", "conv-parent"),
      ).toEqual({ model: "openai/parent" });
    } finally {
      conversation.mockRestore();
      agent.mockRestore();
    }
  });
});
