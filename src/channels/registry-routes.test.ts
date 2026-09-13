import { afterEach, describe, expect, test } from "bun:test";
import {
  __testSetBackend,
  type Backend,
  type ConversationCreateBody,
} from "@/backend";
import {
  createChannelRouteProvisioner,
  resolveConversationModelPin,
} from "@/channels/registry-routes";

const AGENT_MODEL = "anthropic/claude-sonnet-4-5";
const AGENT_MODEL_SETTINGS = {
  provider_type: "anthropic",
  max_output_tokens: 4096,
} as const;

function stubBackend(overrides: {
  retrieveAgent?: (agentId: string) => Promise<unknown>;
  onCreate?: (body: ConversationCreateBody) => void;
}): Backend {
  return {
    retrieveAgent:
      overrides.retrieveAgent ??
      (async () => ({
        id: "agent-1",
        model: AGENT_MODEL,
        model_settings: AGENT_MODEL_SETTINGS,
      })),
    createConversation: async (body: ConversationCreateBody) => {
      overrides.onCreate?.(body);
      return { id: "conv-1", agent_id: body.agent_id };
    },
  } as unknown as Backend;
}

describe("resolveConversationModelPin", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("resolves the agent's current model and model settings", async () => {
    __testSetBackend(stubBackend({}));

    const pin = await resolveConversationModelPin("agent-1");

    expect(pin).toEqual({
      model: AGENT_MODEL,
      model_settings: AGENT_MODEL_SETTINGS,
    });
  });

  test("omits model fields the agent does not define", async () => {
    __testSetBackend(
      stubBackend({
        retrieveAgent: async () => ({ id: "agent-1", model: null }),
      }),
    );

    const pin = await resolveConversationModelPin("agent-1");

    expect(pin).toEqual({});
  });

  test("returns an empty pin when the agent lookup fails", async () => {
    __testSetBackend(
      stubBackend({
        retrieveAgent: async () => {
          throw new Error("agent lookup failed");
        },
      }),
    );

    const pin = await resolveConversationModelPin("agent-1");

    expect(pin).toEqual({});
  });
});

describe("createConversationForAgent", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  function createProvisioner() {
    return createChannelRouteProvisioner({ emitEvent: () => {} });
  }

  test("pins the agent's current model on the created conversation", async () => {
    const bodies: ConversationCreateBody[] = [];
    __testSetBackend(stubBackend({ onCreate: (body) => bodies.push(body) }));

    const conversationId = await createProvisioner().createConversationForAgent(
      "agent-1",
      "Slack thread",
    );

    expect(conversationId).toBe("conv-1");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      agent_id: "agent-1",
      model: AGENT_MODEL,
      model_settings: AGENT_MODEL_SETTINGS,
      summary: "Slack thread",
    });
  });

  test("falls back to modelless creation when the agent lookup fails", async () => {
    const bodies: ConversationCreateBody[] = [];
    __testSetBackend(
      stubBackend({
        retrieveAgent: async () => {
          throw new Error("agent lookup failed");
        },
        onCreate: (body) => bodies.push(body),
      }),
    );

    const conversationId =
      await createProvisioner().createConversationForAgent("agent-1");

    expect(conversationId).toBe("conv-1");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ agent_id: "agent-1" });
    expect(bodies[0]).not.toHaveProperty("model");
    expect(bodies[0]).not.toHaveProperty("model_settings");
  });
});
