import { expect, test } from "bun:test";
import type { APIClient } from "@/backend/backend";
import { conversationCostModel, withClientUsageCost } from "./usage-cost";

test("cloud streams replace server cost and preserve controller identity", async () => {
  const controller = new AbortController();
  const stream = {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "usage_statistics",
        prompt_tokens: 1000,
        completion_tokens: 100,
        cost_usd: 99,
      };
      yield {
        message_type: "usage_statistics",
        prompt_tokens: 1000,
        completion_tokens: 100,
      };
    },
  };
  let lookups = 0;
  withClientUsageCost(stream, async () => {
    lookups++;
    return "anthropic/claude-sonnet-4-5";
  });
  const events = await Array.fromAsync(stream);
  for (const event of events) expect(event.cost_usd).toBeCloseTo(0.0045);
  expect(lookups).toBe(1);
  expect(stream.controller).toBe(controller);
});

test("failed model lookups drop server cost", async () => {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "usage_statistics",
        prompt_tokens: 1,
        completion_tokens: 1,
        cost_usd: 99,
      };
    },
  };
  withClientUsageCost(stream, async () => {
    throw new Error("unavailable");
  });
  for await (const event of stream) expect(event.cost_usd).toBeNull();
});

test("conversation override wins; default and inherited models use the agent", async () => {
  let override: string | null = "anthropic/claude-sonnet-4-5";
  const client = {
    conversations: {
      retrieve: async () => ({ agent_id: "agent-1", model: override }),
    },
    agents: { retrieve: async () => ({ model: "openai/gpt-4o" }) },
  } as unknown as APIClient;
  expect(
    await conversationCostModel(client, "conv-1", null, "openai/gpt-4o"),
  ).toBe("openai/gpt-4o");
  expect(await conversationCostModel(client, "conv-1")).toBe(override);
  override = null;
  expect(await conversationCostModel(client, "conv-1")).toBe("openai/gpt-4o");
  expect(await conversationCostModel(client, "default", "agent-1")).toBe(
    "openai/gpt-4o",
  );
});
