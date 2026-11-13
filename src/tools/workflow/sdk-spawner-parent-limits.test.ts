import { describe, expect, test } from "bun:test";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type { SdkClient, SubagentRequest } from "./types";

const MODEL = "openai/gpt-5.6-luna";
async function queryOptions(
  options: SubagentRequest["options"] = {},
  overrides: Partial<SdkSpawnerConfig> = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client: SdkClient = {
    query({ options }) {
      captured = options;
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
  await createSdkSpawner(client, {
    parentAgentId: "agent-parent",
    model: MODEL,
    resolveModel: (id) => (id === "same" ? MODEL : "anthropic/claude-sonnet-5"),
    parentModelSettings: {
      max_output_tokens: 24000,
      reasoning_effort: "medium",
      temperature: 0.3,
    },
    parentContextWindowLimit: 256000,
    ...overrides,
  })({ prompt: "probe", options, callIndex: 0 }, new AbortController().signal);
  if (!captured) throw new Error("Worker did not reach SDK query()");
  return captured;
}

describe("SDK worker parent limits", () => {
  test("an explicit alias for the same model retains parent budgets and child effort", async () => {
    expect(await queryOptions({ model: "same", effort: "low" })).toMatchObject({
      model: MODEL,
      modelSettings: { max_output_tokens: 24000, reasoning_effort: "low" },
      contextWindowLimit: 256000,
    });
  });
  test("a different model does not inherit the parent budgets", async () => {
    const options = await queryOptions({ model: "sonnet" });
    expect(options.modelSettings).toBeUndefined();
    expect(options.contextWindowLimit).toBeUndefined();
  });
  test("an explicit same-model selection does not inherit unrelated provider settings", async () => {
    expect((await queryOptions({ model: "same" })).modelSettings).toEqual({
      max_output_tokens: 24000,
    });
  });
  test("a workflow default different from the actual parent does not inherit budgets", async () => {
    const options = await queryOptions(
      {},
      { parentModelHandle: "anthropic/claude-sonnet-5" },
    );
    expect(options.modelSettings).toBeUndefined();
    expect(options.contextWindowLimit).toBeUndefined();
  });
  test("an unknown actual parent model does not imply the workflow model matches", async () => {
    const options = await queryOptions({}, { parentModelHandle: null });
    expect(options.modelSettings).toBeUndefined();
    expect(options.contextWindowLimit).toBeUndefined();
  });
  test("resuming a worker does not overwrite its saved budgets with the parent's", async () => {
    const options = await queryOptions(
      { conversationId: "conv-worker" },
      {
        supportsAgentFreeResume: true,
        retrieveConversation: async () => ({
          agent_id: null,
          parent_agent_id: "agent-parent",
          model: MODEL,
        }),
        latestRun: async () => ({
          id: "run-done",
          conversation_id: "conv-worker",
          status: "completed",
        }),
      },
    );
    expect(options.modelSettings).toBeUndefined();
    expect(options.contextWindowLimit).toBeUndefined();
  });
});
