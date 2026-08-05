import { afterEach, expect, test } from "bun:test";
import type { RuntimeScope } from "@/types/app-server-protocol";
import { ChannelRegistry, getChannelRegistry } from "./registry";
import { createRoutedRuntimeRegistrationRefresher } from "./routed-runtime-registration";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  setRouteInMemory,
} from "./routing";
import type { ChannelTurnSource } from "./types";

const runtime: RuntimeScope = {
  agent_id: "agent-1",
  conversation_id: "conv-1",
};

const source: ChannelTurnSource = {
  channel: "slack",
  accountId: "acct-1",
  chatId: "C123",
  chatType: "channel",
  threadId: null,
  agentId: runtime.agent_id,
  conversationId: runtime.conversation_id,
};

afterEach(async () => {
  await getChannelRegistry()?.stopAll();
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

test("registers routed conversations at gateway startup", async () => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
  setRouteInMemory("slack", {
    accountId: source.accountId,
    chatId: source.chatId,
    chatType: "channel",
    threadId: null,
    agentId: runtime.agent_id,
    conversationId: runtime.conversation_id,
    enabled: true,
    outboundEnabled: true,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const registry = new ChannelRegistry();
  registry.registerAdapter({
    id: "slack:acct-1",
    channelId: "slack",
    accountId: "acct-1",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async () => {},
  });

  const registrations: Array<{
    runtime: RuntimeScope;
    sources: ChannelTurnSource[];
  }> = [];
  const refresher = createRoutedRuntimeRegistrationRefresher(
    registry,
    {
      getKnownRuntimes: () => [],
      registerRuntime: async (nextRuntime, sources = []) => {
        registrations.push({ runtime: nextRuntime, sources });
      },
    },
    ["slack"],
  );

  await refresher.refresh();

  expect(registrations).toEqual([{ runtime, sources: [source] }]);
  refresher.close();
});

test("removes the tool registration when a known runtime loses its routes", async () => {
  __testOverrideLoadRoutes(() => null);

  const registrations: ChannelTurnSource[][] = [];
  const refresher = createRoutedRuntimeRegistrationRefresher(
    {
      resolveRoutedTurnSources: () => [],
    },
    {
      getKnownRuntimes: () => [runtime],
      registerRuntime: async (_runtime, sources = []) => {
        registrations.push(sources);
      },
    },
    ["slack"],
  );

  await refresher.refresh();

  expect(registrations).toEqual([[]]);
  refresher.close();
});

test("fails startup when initial MessageChannel registration fails", async () => {
  __testOverrideLoadRoutes(() => null);
  const refresher = createRoutedRuntimeRegistrationRefresher(
    { resolveRoutedTurnSources: () => [source] },
    {
      getKnownRuntimes: () => [],
      registerRuntime: async () => {
        throw new Error("listener unavailable");
      },
    },
    ["slack"],
  );

  await expect(refresher.refresh()).rejects.toThrow("listener unavailable");
  refresher.close();
});

test("retries a failed MessageChannel unregister until it succeeds", async () => {
  __testOverrideLoadRoutes(() => null);
  let attempts = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const refresher = createRoutedRuntimeRegistrationRefresher(
    { resolveRoutedTurnSources: () => [] },
    {
      getKnownRuntimes: () => [runtime],
      registerRuntime: async (_runtime, sources = []) => {
        attempts++;
        expect(sources).toEqual([]);
        if (attempts === 1) throw new Error("temporary failure");
        finish();
      },
    },
    ["slack"],
    undefined,
    0,
  );

  refresher.requestRefresh();
  await Promise.race([
    finished,
    Bun.sleep(1000).then(() => {
      throw new Error("registration retry timed out");
    }),
  ]);

  expect(attempts).toBe(2);
  refresher.close();
});

test("runs another pass when registration changes during a refresh", async () => {
  __testOverrideLoadRoutes(() => null);
  let attempts = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let refresher!: ReturnType<typeof createRoutedRuntimeRegistrationRefresher>;
  refresher = createRoutedRuntimeRegistrationRefresher(
    { resolveRoutedTurnSources: () => [source] },
    {
      getKnownRuntimes: () => [],
      registerRuntime: async () => {
        attempts++;
        if (attempts === 1) refresher.requestRefresh();
        if (attempts === 2) finish();
      },
    },
    ["slack"],
  );

  refresher.requestRefresh();
  await Promise.race([
    finished,
    Bun.sleep(1000).then(() => {
      throw new Error("second registration pass timed out");
    }),
  ]);

  expect(attempts).toBe(2);
  refresher.close();
});
