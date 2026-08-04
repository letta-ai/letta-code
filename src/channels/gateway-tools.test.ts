import { expect, test } from "bun:test";
import { buildChannelGatewayExternalTools } from "./gateway-tools";
import type { ChannelTurnSource } from "./types";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };
const baseTool = {
  description: "Send a message through a channel",
  schema: { type: "object", properties: {} },
};
const source: ChannelTurnSource = {
  channel: "telegram",
  accountId: "telegram-default",
  chatId: "chat-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

test("gateway tool resolution follows routed source eligibility", async () => {
  let sources = [source];
  const registry = {
    resolveTurnSourcesForScope: () => sources,
  };

  const eligible = await buildChannelGatewayExternalTools(
    registry,
    runtime,
    baseTool,
  );
  expect(eligible.map((tool) => tool.name)).toEqual(["MessageChannel"]);

  sources = [];
  await expect(
    buildChannelGatewayExternalTools(registry, runtime, baseTool),
  ).resolves.toEqual([]);
});
