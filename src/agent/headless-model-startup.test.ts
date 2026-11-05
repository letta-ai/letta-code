import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend, ConversationCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { clearAvailableModelsCache } from "./available-models";
import { prepareExistingHeadlessModel } from "./headless-model-startup";
import { resolveModel } from "./model";

type UpdateCall = { id: string; body: Record<string, unknown> };

const OPUS_HANDLE = "anthropic/claude-opus-4-8";

function makeAgent(contextWindow: number): AgentState {
  return {
    id: "agent-1",
    model: OPUS_HANDLE,
    llm_config: {
      model: "claude-opus-4-8",
      model_endpoint_type: "anthropic",
      context_window: contextWindow,
    },
  } as unknown as AgentState;
}

let updateAgentCalls: UpdateCall[];

setupRuntimeModelCatalogFixture();
beforeEach(() => {
  updateAgentCalls = [];
  __testSetBackend({
    capabilities: { localModelCatalog: false },
    listModels: async () => [],
    updateAgent: async (id: string, body: Record<string, unknown>) => {
      updateAgentCalls.push({ id, body });
      return {};
    },
    retrieveAgent: async () => makeAgent(0),
  } as unknown as Backend);
  clearAvailableModelsCache();
});

afterEach(() => {
  __testSetBackend(null);
  clearAvailableModelsCache();
});

// The SDK's conversation create type doesn't declare context_window_limit,
// though the API accepts it.
function contextWindowLimit(
  conversationModel: Partial<ConversationCreateBody> | undefined,
): unknown {
  return (conversationModel as { context_window_limit?: number } | undefined)
    ?.context_window_limit;
}

async function prepare(
  agent: AgentState,
  modelIdentifier: string,
  createsConversation: boolean,
) {
  const modelHandle = resolveModel(modelIdentifier);
  if (typeof modelHandle !== "string") {
    throw new Error(`fixture has no model ${modelIdentifier}`);
  }
  return prepareExistingHeadlessModel({
    agent,
    modelIdentifier,
    modelHandle,
    createsConversation,
    localModelCatalog: false,
  });
}

describe("prepareExistingHeadlessModel context window", () => {
  test("keeps the agent's window on a tier change within the same variant", async () => {
    const { conversationModel } = await prepare(
      makeAgent(262_144),
      "opus-4.8-max",
      true,
    );

    expect(conversationModel?.model).toBe(OPUS_HANDLE);
    expect(contextWindowLimit(conversationModel)).toBe(262_144);
    expect(
      (conversationModel?.model_settings as { effort?: string }).effort,
    ).toBe("max");
  });

  test("uses the selected entry's window for a different variant of the same model", async () => {
    const { conversationModel } = await prepare(
      makeAgent(262_144),
      "opus-4.8-1m",
      true,
    );

    expect(contextWindowLimit(conversationModel)).toBe(950_000);
  });

  test("uses the selected entry's window for a different model", async () => {
    const { conversationModel } = await prepare(
      makeAgent(262_144),
      "sonnet-4.6",
      true,
    );

    expect(contextWindowLimit(conversationModel)).toBe(200_000);
  });

  test("heals a window that looks like the legacy 128k server clamp", async () => {
    const { conversationModel } = await prepare(
      makeAgent(128_000),
      "opus-4.8-max",
      true,
    );

    expect(contextWindowLimit(conversationModel)).toBe(200_000);
  });

  test("re-sends the agent's window when updating the agent in place", async () => {
    await prepare(makeAgent(262_144), "opus-4.8-max", false);

    expect(updateAgentCalls).toHaveLength(1);
    expect(updateAgentCalls[0]?.body.model).toBe(OPUS_HANDLE);
    expect(updateAgentCalls[0]?.body.context_window_limit).toBe(262_144);
  });

  test("sends the selected entry's window when updating the agent to a different variant", async () => {
    await prepare(makeAgent(262_144), "opus-4.8-1m", false);

    expect(updateAgentCalls[0]?.body.context_window_limit).toBe(950_000);
  });
});
