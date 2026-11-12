import { describe, expect, test } from "bun:test";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type { SdkClient, SubagentRequest } from "./types";

const CONFIG: SdkSpawnerConfig = {
  parentAgentId: "agent-parent",
  model: "openai/gpt-5.6-luna",
  resolveModel: (id) => (id === "sonnet" ? "anthropic/claude-sonnet-5" : null),
};
function request(options: SubagentRequest["options"] = {}): SubagentRequest {
  return { prompt: "probe", options, callIndex: 0 };
}
function fakeClient(): SdkClient & {
  calls: Array<{ options: Record<string, unknown> }>;
} {
  const calls: Array<{ options: Record<string, unknown> }> = [];
  return {
    calls,
    query(params) {
      calls.push(params);
      return {
        conversationId: "conv-worker",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          yield { type: "result", success: true, result: "done" };
        },
        async interrupt() {},
        close() {},
      };
    },
  };
}

describe("SDK worker parent limits", () => {
  test("an explicit alias for the same model retains parent budgets and child effort", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      resolveModel: (id) => (id === "same" ? CONFIG.model : null),
      parentModelSettings: {
        max_output_tokens: 24000,
        reasoning_effort: "medium",
      },
      parentContextWindowLimit: 256000,
    })(request({ model: "same", effort: "low" }), new AbortController().signal);
    expect(client.calls[0]?.options).toMatchObject({
      model: CONFIG.model,
      modelSettings: { max_output_tokens: 24000, reasoning_effort: "low" },
      contextWindowLimit: 256000,
    });
  });

  test("a different model does not inherit the parent budgets", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      parentModelSettings: { max_output_tokens: 24000 },
      parentContextWindowLimit: 256000,
    })(request({ model: "sonnet" }), new AbortController().signal);
    expect(client.calls[0]?.options.modelSettings).toBeUndefined();
    expect(client.calls[0]?.options.contextWindowLimit).toBeUndefined();
  });

  test("an explicit same-model selection does not inherit unrelated provider settings", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      resolveModel: () => CONFIG.model,
      parentModelSettings: {
        max_output_tokens: 24000,
        reasoning_effort: "medium",
        temperature: 0.3,
      },
    })(request({ model: "same" }), new AbortController().signal);
    expect(client.calls[0]?.options.modelSettings).toEqual({
      max_output_tokens: 24000,
    });
  });

  test("a workflow default different from the actual parent does not inherit budgets", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      parentModelHandle: "anthropic/claude-sonnet-5",
      parentModelSettings: { max_output_tokens: 24000 },
      parentContextWindowLimit: 256000,
    })(request(), new AbortController().signal);
    expect(client.calls[0]?.options.modelSettings).toBeUndefined();
    expect(client.calls[0]?.options.contextWindowLimit).toBeUndefined();
  });

  test("an unknown actual parent model does not imply the workflow model matches", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      parentModelHandle: null,
      parentModelSettings: { max_output_tokens: 24000 },
      parentContextWindowLimit: 256000,
    })(request(), new AbortController().signal);
    expect(client.calls[0]?.options.modelSettings).toBeUndefined();
    expect(client.calls[0]?.options.contextWindowLimit).toBeUndefined();
  });

  test("resuming a worker does not overwrite its saved budgets with the parent's", async () => {
    const client = fakeClient();
    await createSdkSpawner(client, {
      ...CONFIG,
      supportsAgentFreeResume: true,
      parentModelSettings: { max_output_tokens: 24000 },
      parentContextWindowLimit: 256000,
      retrieveConversation: async () => ({
        agent_id: null,
        parent_agent_id: "agent-parent",
        model: CONFIG.model,
      }),
      latestRun: async () => ({
        id: "run-done",
        conversation_id: "conv-worker",
        status: "completed",
      }),
    })(
      request({ conversationId: "conv-worker" }),
      new AbortController().signal,
    );
    expect(client.calls[0]?.options.modelSettings).toBeUndefined();
    expect(client.calls[0]?.options.contextWindowLimit).toBeUndefined();
  });
});
