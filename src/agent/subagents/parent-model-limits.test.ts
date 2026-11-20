import { describe, expect, spyOn, test } from "bun:test";
import { resolveParentModelLimits } from "@/agent/subagents/parent-model-limits";
import { getBackend } from "@/backend";

describe("parent model limits", () => {
  // Description, conversation ID/state, expected model/output/context.
  test.each([
    ["agent defaults", "default", {}, "openai/parent", 16000, 128000],
    [
      "partial same-model override",
      "conv-parent",
      { model: "openai/parent", model_settings: { max_output_tokens: 24000 } },
      "openai/parent",
      24000,
      128000,
    ],
    [
      "inherited model override",
      "conv-parent",
      {
        model: null,
        model_settings: { max_output_tokens: 24000 },
        context_window_limit: 256000,
      },
      "openai/parent",
      24000,
      256000,
    ],
    [
      "different model",
      "conv-parent",
      { model: "anthropic/other" },
      "anthropic/other",
      undefined,
      undefined,
    ],
    [
      "different model with own output",
      "conv-parent",
      { model: "anthropic/other", model_settings: { max_output_tokens: 4000 } },
      "anthropic/other",
      4000,
      undefined,
    ],
    [
      "null and invalid limits",
      "conv-parent",
      {
        model: null,
        model_settings: { max_output_tokens: -1 },
        context_window_limit: null,
      },
      "openai/parent",
      16000,
      128000,
    ],
  ] as const)(
    "%s",
    async (_name, conversationId, conversation, model, output, context) => {
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
        const result = await resolveParentModelLimits(
          "agent-parent",
          conversationId,
        );
        expect(result?.model).toBe(model);
        expect(result?.modelSettings).toEqual(
          output === undefined ? undefined : { max_output_tokens: output },
        );
        expect(result?.contextWindowLimit).toBe(context);
        if (conversationId === "default") expect(lookup).not.toHaveBeenCalled();
        else expect(lookup).toHaveBeenCalledWith("conv-parent");
      } finally {
        lookup.mockRestore();
        agent.mockRestore();
      }
    },
  );

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
