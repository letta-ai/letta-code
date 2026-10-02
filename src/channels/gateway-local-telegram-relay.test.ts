import { expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { HeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { attachLocalSegmentIdentity } from "@/backend/local/local-stream-chunks";
import { startLocalChannelGateway } from "@/channels/gateway-local";
import { addRoute } from "@/channels/routing";
import {
  createChannelAccountLive,
  updateChannelAccountLive,
} from "@/channels/service";
import type { ChannelTurnLifecycleEvent } from "@/channels/types";
import { settingsManager } from "@/settings-manager";
import { startAppServer } from "@/websocket/app-server";
import {
  FakeBot,
  getChannelRegistry,
  installTelegramAdapterTestHooks,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

const ACCOUNT_ID = "telegram-relay-integration";
const AGENT_ID = "agent-telegram-relay-integration";
const CHAT_ID = "123";
const FINAL_TEXT = "cross-boundary reply";
const BEFORE_TOOL_TEXT = "before tool";
const AFTER_TOOL_TEXT = "after tool";
const TEST_TIMEOUT_MS = 10_000;

type TurnPlan = {
  text: string;
  assistantMessagesAroundTool?: [string, string];
  started?: () => void;
  waitForRelease?: Promise<void>;
};

function assistantMessagesAroundToolStream(
  first: string,
  second: string,
  sequence: number,
): ReturnType<typeof createAssistantMessageStream> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield attachLocalSegmentIdentity(
        {
          message_type: "assistant_message",
          id: `telegram-relay-assistant-${sequence}-1`,
          content: [{ type: "text", text: first }],
        },
        { contentStartIndex: 0, useSourceMessageId: true },
      );
      yield {
        message_type: "tool_call_message",
        id: `telegram-relay-tool-${sequence}`,
        tool_call: {
          tool_call_id: `telegram-relay-tool-call-${sequence}`,
          name: "Bash",
          arguments: JSON.stringify({ command: "true" }),
        },
      };
      yield attachLocalSegmentIdentity(
        {
          message_type: "assistant_message",
          id: `telegram-relay-assistant-${sequence}-2`,
          content: [{ type: "text", text: second }],
        },
        { contentStartIndex: 2, useSourceMessageId: false },
      );
      yield { message_type: "stop_reason", stop_reason: "end_turn" };
    },
  } as unknown as ReturnType<typeof createAssistantMessageStream>;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function inboundMessage(messageId: number, text: string) {
  return {
    message: {
      chat: { id: Number(CHAT_ID), type: "private" },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text,
      date: 1_736_380_800 + messageId,
      message_id: messageId,
    },
  };
}

function plannedExecutor(
  plans: TurnPlan[],
  clientToolNamesByTurn: string[][],
): HeadlessTurnExecutor {
  let turnSequence = 0;
  return {
    async execute(input) {
      const plan = plans.shift();
      if (!plan) throw new Error("Unexpected channel turn");
      turnSequence += 1;
      clientToolNamesByTurn.push(
        (
          (input.body as { client_tools?: Array<{ name: string }> })
            .client_tools ?? []
        ).map((tool) => tool.name),
      );
      plan.started?.();
      await plan.waitForRelease;
      if (plan.assistantMessagesAroundTool) {
        return assistantMessagesAroundToolStream(
          plan.assistantMessagesAroundTool[0],
          plan.assistantMessagesAroundTool[1],
          turnSequence,
        );
      }
      return createAssistantMessageStream({
        id: `telegram-relay-assistant-${turnSequence}`,
        content: [{ type: "text", text: plan.text }],
      });
    },
  };
}

test("a queued local App Server input retains its own reply mode", async () => {
  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalIsMemfsExplicitlyDisabled =
    settingsManager.isMemfsExplicitlyDisabled;
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
  settingsManager.isMemfsExplicitlyDisabled = (agentId) =>
    agentId === AGENT_ID ||
    originalIsMemfsExplicitlyDisabled.call(settingsManager, agentId);

  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const plans: TurnPlan[] = [
    {
      text: "first tool-mode reply",
      started: firstStarted.resolve,
      waitForRelease: releaseFirst.promise,
    },
    { text: "queued relay-mode reply" },
    {
      text: FINAL_TEXT,
      assistantMessagesAroundTool: [BEFORE_TOOL_TEXT, AFTER_TOOL_TEXT],
    },
  ];
  const clientToolNamesByTurn: string[][] = [];
  let server: Awaited<ReturnType<typeof startAppServer>> | undefined;
  let gateway: Awaited<ReturnType<typeof startLocalChannelGateway>> | undefined;

  try {
    const backend = new HeadlessBackend(
      AGENT_ID,
      plannedExecutor(plans, clientToolNamesByTurn),
    );
    const conversation = await backend.createConversation({
      agent_id: AGENT_ID,
    });
    __testSetBackend(backend);

    createChannelAccountLive(
      "telegram",
      {
        displayName: "Telegram Relay Integration",
        enabled: true,
        token: "test-token",
        dmPolicy: "open",
        groupMode: "open",
        richPrivateChatDefault: false,
        replyMode: "tool",
      },
      { accountId: ACCOUNT_ID },
    );
    addRoute("telegram", {
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      chatType: "direct",
      threadId: null,
      agentId: AGENT_ID,
      conversationId: conversation.id,
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    server = await startAppServer({ listen: "ws://127.0.0.1:0" });
    gateway = await startLocalChannelGateway({
      appServerUrl: server.controlUrl,
      channelNames: ["telegram"],
      failOnStartupError: true,
    });

    const registry = getChannelRegistry();
    const adapter = registry?.getAdapter("telegram", ACCOUNT_ID);
    const bot = FakeBot.instances[0];
    if (!registry || !adapter || !bot) {
      throw new Error("Telegram gateway did not initialize");
    }

    let finishedTurns = 0;
    const handleLifecycle = adapter.handleTurnLifecycleEvent;
    adapter.handleTurnLifecycleEvent = async (
      event: ChannelTurnLifecycleEvent,
    ) => {
      await handleLifecycle?.call(adapter, event);
      if (event.type === "finished") finishedTurns += 1;
    };

    await bot.emit("message", inboundMessage(1, "first tool-mode message"));
    await firstStarted.promise;
    updateChannelAccountLive("telegram", ACCOUNT_ID, { replyMode: "relay" });
    await bot.emit("message", inboundMessage(2, "queued behind first turn"));
    releaseFirst.resolve();
    await waitFor(
      () => finishedTurns === 2,
      "Timed out waiting for queued mixed-mode turns",
    );
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      1,
      CHAT_ID,
      "queued relay-mode reply",
      expect.any(Object),
    );
    expect(clientToolNamesByTurn[0]).toContain("MessageChannel");
    expect(clientToolNamesByTurn[1]).not.toContain("MessageChannel");

    await bot.emit("message", inboundMessage(3, "relay after queue drained"));
    await waitFor(
      () => finishedTurns === 3,
      "Timed out waiting for relay turn after queue drain",
    );
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      2,
      CHAT_ID,
      BEFORE_TOOL_TEXT,
      expect.any(Object),
    );
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      3,
      CHAT_ID,
      AFTER_TOOL_TEXT,
      expect.any(Object),
    );
    expect(clientToolNamesByTurn[2]).not.toContain("MessageChannel");
    expect(plans).toHaveLength(0);
  } finally {
    settingsManager.isMemfsExplicitlyDisabled =
      originalIsMemfsExplicitlyDisabled;
    if (originalDisableMods === undefined) {
      delete process.env.LETTA_DISABLE_MODS;
    } else {
      process.env.LETTA_DISABLE_MODS = originalDisableMods;
    }
    if (originalDisableCron === undefined) {
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    } else {
      process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    }
    try {
      await gateway?.close();
    } finally {
      await server?.close();
    }
  }
});
