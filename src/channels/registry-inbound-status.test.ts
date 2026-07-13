import { expect, test } from "bun:test";
import {
  buildInboundChannelStatusContext,
} from "./registry-inbound";
import type { ChannelAdapter, ChannelRoute } from "./types";

const adapter = {
  isRunning: () => true,
} as ChannelAdapter;

const route: ChannelRoute = {
  chatId: "34600216777@s.whatsapp.net",
  agentId: "agent-local-test",
  conversationId: "local-conv-test",
  enabled: true,
  createdAt: "2026-07-13T00:00:00.000Z",
};

test("WhatsApp inbound status includes runtime model and channel build", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    channelId: "whatsapp",
    route,
    resolveModelStatus: async () => ({
      modelLabel: "GPT-5.6 Sol",
      modelHandle: "openai/gpt-5.6-sol",
      scope: "conversation",
    }),
  });

  expect(context.activeModel).toBe(
    "GPT-5.6 Sol (openai/gpt-5.6-sol)",
  );
  expect(context.buildNumber).toBe("0.28.2-whatsapp.1");
});
