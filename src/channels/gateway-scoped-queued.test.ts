import { expect, test } from "bun:test";
import WebSocket from "ws";
import { createAppServerClient } from "@/app-server-client";
import { HeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { __testSetBackend } from "@/backend/index";
import { settingsManager } from "@/settings-manager";
import { startAppServer } from "@/websocket/app-server";
import { ChannelGateway } from "./gateway-core";
import type { ChannelGatewayHooks } from "./gateway-types";
import type { ChannelTurnSource } from "./types";

const AGENT_ID = "agent-scoped-queued-tools";
const WAIT_TIMEOUT_MS = 5_000;

type TestChannel = "discord" | "slack" | "telegram";

interface ScenarioDelivery {
  channel: TestChannel;
  automaticRelay: boolean;
}

interface ScenarioObservation {
  channelEnumsByTurn: string[][];
  relayedDestinations: string[];
}

function makeSource(
  channel: TestChannel,
  conversationId: string,
): ChannelTurnSource {
  return {
    channel,
    accountId: `${channel}-account`,
    chatId: `${channel}-chat`,
    chatType: "channel",
    threadId: null,
    agentId: AGENT_ID,
    conversationId,
  };
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(`Timed out waiting for ${description}`);
}

async function runQueuedScenario(
  deliveries: ScenarioDelivery[],
): Promise<ScenarioObservation> {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const channelEnumsByTurn: string[][] = [];
  const relayedDestinations: string[] = [];
  let executionCount = 0;
  const executor: HeadlessTurnExecutor = {
    async execute(input) {
      executionCount += 1;
      const tools =
        (
          input.body as {
            client_tools?: Array<{
              name: string;
              parameters?: {
                properties?: { channel?: { enum?: string[] } };
              };
            }>;
          }
        ).client_tools ?? [];
      const messageChannel = tools.find(
        (tool) => tool.name === "MessageChannel",
      );
      channelEnumsByTurn.push(
        messageChannel?.parameters?.properties?.channel?.enum ?? [],
      );
      if (executionCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return createAssistantMessageStream({
        content: [{ type: "text", text: `reply-${executionCount}` }],
      });
    },
  };

  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalMemfs = settingsManager.isMemfsExplicitlyDisabled;
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
  settingsManager.isMemfsExplicitlyDisabled = () => true;

  const backend = new HeadlessBackend(AGENT_ID, executor);
  const conversation = await backend.createConversation({ agent_id: AGENT_ID });
  __testSetBackend(backend);
  const runtime = {
    agent_id: AGENT_ID,
    conversation_id: conversation.id,
  };
  const server = await startAppServer({ listen: "ws://127.0.0.1:0" });
  const client = createAppServerClient({
    url: server.controlUrl,
    WebSocket: WebSocket as never,
  });
  await client.connect();
  const relayChannels = new Set(
    deliveries
      .filter((delivery) => delivery.automaticRelay)
      .map((delivery) => delivery.channel),
  );
  const hooks: ChannelGatewayHooks = {
    buildExternalTool: async (_runtime, sources, policy) =>
      policy?.automaticRelay
        ? null
        : {
            name: "MessageChannel",
            description: `Send through ${sources[0]?.channel ?? "none"}`,
            parameters: {
              type: "object",
              properties: {
                channel: {
                  type: "string",
                  enum: [...new Set(sources.map((source) => source.channel))],
                },
              },
            },
          },
    resolveAssistantRelayPolicy: (_runtime, sources) =>
      sources.every((source) =>
        relayChannels.has(source.channel as TestChannel),
      ),
    executeExternalTool: async () => ({
      content: [{ type: "text", text: "ok" }],
    }),
    relayAssistantText: ({ sources }) => {
      if (sources.length === 1 && sources[0]) {
        relayedDestinations.push(`${sources[0].channel}:${sources[0].chatId}`);
      }
    },
    onLifecycle: () => {},
    onProgress: () => {},
    onControlRequest: () => {},
  };
  const gateway = new ChannelGateway(client, hooks);

  try {
    const [first, ...queued] = deliveries;
    if (!first) throw new Error("Scenario requires at least one delivery");
    await gateway.submit({
      runtime,
      content: `${first.channel} active`,
      sources: [makeSource(first.channel, conversation.id)],
      clientMessageId: `cm-${first.channel}`,
    });
    await firstStarted.promise;
    for (const delivery of queued) {
      await gateway.submit({
        runtime,
        content: `${delivery.channel} queued`,
        sources: [makeSource(delivery.channel, conversation.id)],
        clientMessageId: `cm-${delivery.channel}`,
      });
    }
    releaseFirst.resolve();
    const expectedRelayCount = deliveries.filter(
      (delivery) => delivery.automaticRelay,
    ).length;
    await waitFor(
      () =>
        channelEnumsByTurn.length === deliveries.length &&
        relayedDestinations.length === expectedRelayCount,
      `${deliveries.length} turns and ${expectedRelayCount} relay outputs`,
    );
    return { channelEnumsByTurn, relayedDestinations };
  } finally {
    releaseFirst.resolve();
    gateway.close();
    await server.close();
    __testSetBackend(null);
    settingsManager.isMemfsExplicitlyDisabled = originalMemfs;
    if (originalDisableMods === undefined)
      delete process.env.LETTA_DISABLE_MODS;
    else process.env.LETTA_DISABLE_MODS = originalDisableMods;
    if (originalDisableCron === undefined) {
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    } else {
      process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    }
  }
}

test(
  "queued Telegram gets its own tool scope after active tool-mode Slack",
  async () => {
    const observed = await runQueuedScenario([
      { channel: "slack", automaticRelay: false },
      { channel: "telegram", automaticRelay: false },
    ]);

    expect(observed.channelEnumsByTurn).toEqual([["slack"], ["telegram"]]);
    expect(observed.relayedDestinations).toEqual([]);
  },
  WAIT_TIMEOUT_MS * 2,
);

test(
  "queued Telegram keeps its tool scope after active relay-mode Slack",
  async () => {
    const observed = await runQueuedScenario([
      { channel: "slack", automaticRelay: true },
      { channel: "telegram", automaticRelay: false },
    ]);

    expect(observed.channelEnumsByTurn).toEqual([[], ["telegram"]]);
    expect(observed.relayedDestinations).toEqual(["slack:slack-chat"]);
  },
  WAIT_TIMEOUT_MS * 2,
);

test(
  "distinct queued relay destinations remain separate turns without MessageChannel",
  async () => {
    const observed = await runQueuedScenario([
      { channel: "discord", automaticRelay: true },
      { channel: "slack", automaticRelay: true },
      { channel: "telegram", automaticRelay: true },
    ]);

    expect(observed.channelEnumsByTurn).toEqual([[], [], []]);
    expect(observed.relayedDestinations).toEqual([
      "discord:discord-chat",
      "slack:slack-chat",
      "telegram:telegram-chat",
    ]);
  },
  WAIT_TIMEOUT_MS * 2,
);
