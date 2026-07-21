import { expect, test } from "bun:test";
import { buildInboundChannelStatusContext } from "./registry-inbound";
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

test("WhatsApp inbound status includes runtime model", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    route,
    resolveModelStatus: async () => ({
      modelLabel: "GPT-5.6 Sol",
      modelHandle: "openai/gpt-5.6-sol",
    }),
  });

  expect(context.activeModel).toEqual({
    modelLabel: "GPT-5.6 Sol",
    modelHandle: "openai/gpt-5.6-sol",
  });
});

test("activeModel is undefined when no route exists", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    route: null,
    resolveModelStatus: async () => ({
      modelLabel: "GPT-5.6 Sol",
      modelHandle: "openai/gpt-5.6-sol",
    }),
  });

  expect(context.activeModel).toBeUndefined();
});

test("activeModel is undefined when model lookup throws", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    route,
    resolveModelStatus: async () => {
      throw new Error("runtime unavailable");
    },
  });

  expect(context.activeModel).toBeUndefined();
});

test("activeModel is undefined when enrichment is disabled", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    route,
    includeActiveModel: false,
    resolveModelStatus: async () => ({
      modelLabel: "GPT-5.6 Sol",
      modelHandle: "openai/gpt-5.6-sol",
    }),
  });

  expect(context.activeModel).toBeUndefined();
});

test("activeModel preserves a handle used as the fallback label", async () => {
  const context = await buildInboundChannelStatusContext({
    adapter,
    accountConfigured: true,
    accountEnabled: true,
    route,
    resolveModelStatus: async () => ({
      modelLabel: "custom/model",
      modelHandle: "custom/model",
    }),
  });

  expect(context.activeModel).toEqual({
    modelLabel: "custom/model",
    modelHandle: "custom/model",
  });
});
