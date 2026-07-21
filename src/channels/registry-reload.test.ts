import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  listChannelAccounts,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import {
  __testClearUserChannelPluginCache,
  loadChannelPlugin,
} from "@/channels/plugin-registry";
import {
  ChannelInitializationError,
  ChannelRegistry,
  getChannelRegistry,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type {
  ChannelControlRequestEvent,
  ChannelRoute,
  CustomChannelAccount,
  InboundChannelMessage,
} from "./types";

type ReloadTestState = {
  events: string[];
  failStartGeneration: string | null;
  hangStartGeneration: string | null;
  startGate: Promise<void> | null;
  onStart: ((generation: string) => void) | null;
};

const reloadTestGlobal = globalThis as typeof globalThis & {
  __lettaChannelReloadTestState?: ReloadTestState;
};

let channelsRoot: string;
let loadedAccounts: CustomChannelAccount[];
let loadedRoutes: ChannelRoute[] | null;
const account: CustomChannelAccount = {
  channel: "demo",
  accountId: "acct-demo",
  enabled: true,
  dmPolicy: "open",
  allowedUsers: [],
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  config: {},
};

function writePlugin(generation: string): void {
  const channelDir = join(channelsRoot, "demo");
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, "channel.json"),
    `${JSON.stringify({
      id: "demo",
      displayName: "Demo",
      entry: "./plugin.mjs",
      runtimePackages: [],
      runtimeModules: [],
    })}\n`,
  );
  writeFileSync(
    join(channelDir, "plugin.mjs"),
    `const state = globalThis.__lettaChannelReloadTestState;
     export const channelPlugin = {
       generation: ${JSON.stringify(generation)},
       metadata: { id: "demo", displayName: "Demo" },
       createAdapter(account) {
         let running = false;
         return {
           id: "demo:" + account.accountId,
           channelId: "demo",
           accountId: account.accountId,
           name: "Demo ${generation}:" + String(account.config?.version ?? "unset"),
           async start() {
             state.events.push("start:${generation}");
             state.onStart?.(${JSON.stringify(generation)});
             if (state.failStartGeneration === ${JSON.stringify(generation)}) {
               throw new Error("start failed:${generation}");
             }
             if (state.hangStartGeneration === ${JSON.stringify(generation)}) {
               await state.startGate;
             }
             running = true;
           },
           async stop() {
             state.events.push("stop:${generation}");
             running = false;
           },
           isRunning() { return running; },
           async sendMessage() { return { messageId: "demo-message" }; },
           async sendDirectReply() {}
         };
       }
     };\n`,
  );
}

function inbound(messageId: string): InboundChannelMessage {
  return {
    channel: "demo",
    accountId: account.accountId,
    chatId: "chat-demo",
    chatType: "direct",
    senderId: "user-demo",
    text: messageId,
    messageId,
    timestamp: Date.now(),
  };
}

async function createStartedRegistry(): Promise<{
  registry: ChannelRegistry;
  deliveredMessageIds: string[];
}> {
  const deliveredMessageIds: string[] = [];
  const registry = new ChannelRegistry();
  registry.setConfiguredChannelScope(["other"], null);
  registry.setMessageHandler((delivery) => {
    deliveredMessageIds.push(delivery.turnSources?.[0]?.messageId ?? "missing");
  });
  registry.setReady();
  await registry.startChannelAccount("demo", account.accountId);
  addRoute("demo", {
    accountId: account.accountId,
    chatId: "chat-demo",
    chatType: "direct",
    agentId: "agent-demo",
    conversationId: "conv-demo",
    enabled: true,
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  return { registry, deliveredMessageIds };
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-reload-"));
  loadedAccounts = [{ ...account, config: { ...account.config } }];
  loadedRoutes = null;
  __testOverrideChannelsRoot(channelsRoot);
  __testOverrideLoadChannelAccounts((channelId) =>
    channelId === "demo" ? loadedAccounts : [],
  );
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes((channelId) =>
    channelId === "demo" ? loadedRoutes : [],
  );
  __testOverrideSaveRoutes(() => {});
  __testOverrideLoadPairingStore(() => null);
  __testOverrideSavePairingStore(() => {});
  __testOverrideLoadPendingControlRequestStore(() => ({ requests: [] }));
  __testOverrideSavePendingControlRequestStore(() => {});
  __testOverrideLoadTargetStore(() => null);
  __testOverrideSaveTargetStore(() => {});
  reloadTestGlobal.__lettaChannelReloadTestState = {
    events: [],
    failStartGeneration: null,
    hangStartGeneration: null,
    startGate: null,
    onStart: null,
  };
  writePlugin("one");
});

afterEach(async () => {
  await getChannelRegistry()?.stopAll();
  delete reloadTestGlobal.__lettaChannelReloadTestState;
  __testClearUserChannelPluginCache();
  clearChannelAccountStores();
  clearAllRoutes();
  clearPairingStores();
  clearPendingControlRequestStore();
  clearTargetStores();
  __testOverrideChannelsRoot(null);
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __testOverrideLoadPairingStore(null);
  __testOverrideSavePairingStore(null);
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  __testOverrideLoadTargetStore(null);
  __testOverrideSaveTargetStore(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

describe("ChannelRegistry queued reload", () => {
  test("refreshes edited accounts and replaces added or deleted routes", async () => {
    const { registry } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    const deliveredAgentIds: string[] = [];
    registry.setMessageHandler((delivery) => {
      deliveredAgentIds.push(delivery.route.agentId);
    });
    const secondAccount: CustomChannelAccount = {
      ...account,
      accountId: "acct-second",
      config: { version: "second" },
    };
    loadedAccounts = [
      { ...account, config: { version: "edited" } },
      secondAccount,
    ];
    loadedRoutes = [
      {
        accountId: account.accountId,
        chatId: "chat-demo",
        chatType: "direct",
        agentId: "agent-rerouted",
        conversationId: "conv-rerouted",
        enabled: true,
        createdAt: "2026-07-21T00:00:00.000Z",
      },
      {
        accountId: secondAccount.accountId,
        chatId: "chat-fresh",
        chatType: "direct",
        agentId: "agent-fresh",
        conversationId: "conv-fresh",
        enabled: true,
        createdAt: "2026-07-21T00:00:00.000Z",
      },
    ];

    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshPromise = registry.reloadConfiguredChannels({
      beforeRestart: () => refreshGate,
    });
    await oldAdapter?.onMessage?.(inbound("buffered-reroute"));
    expect(deliveredAgentIds).toEqual([]);
    releaseRefresh();
    const refreshed = await refreshPromise;
    expect(refreshed.restarted).toContain("demo/acct-demo");
    expect(refreshed.restarted).toContain("demo/acct-second");
    expect(registry.getAdapter("demo", "acct-demo")?.name).toBe(
      "Demo one:edited",
    );
    expect(registry.getAdapter("demo", "acct-second")?.name).toBe(
      "Demo one:second",
    );
    expect(
      registry.getRoute("demo", "chat-demo", account.accountId),
    ).toMatchObject({
      agentId: "agent-rerouted",
      conversationId: "conv-rerouted",
    });
    expect(
      registry.getRoute("demo", "chat-fresh", secondAccount.accountId),
    ).toMatchObject({
      agentId: "agent-fresh",
      conversationId: "conv-fresh",
    });
    expect(deliveredAgentIds).toEqual(["agent-rerouted"]);

    loadedAccounts = [{ ...secondAccount, enabled: false }];
    loadedRoutes = [];
    const removed = await registry.reloadConfiguredChannels();
    expect(removed.stopped).toEqual(
      expect.arrayContaining(["demo/acct-demo", "demo/acct-second"]),
    );
    expect(registry.getAdapter("demo", "acct-demo")).toBeNull();
    expect(registry.getAdapter("demo", "acct-second")).toBeNull();
    expect(
      registry.getRoute("demo", "chat-fresh", secondAccount.accountId),
    ).toBeNull();
  });

  test("restore-mode reload discovers a newly enabled channel type", async () => {
    const registry = new ChannelRegistry();
    registry.setConfiguredChannelScope([], "all");
    registry.setMessageHandler(() => {});
    registry.setReady();

    const summary = await registry.reloadConfiguredChannels();

    expect(summary.restarted).toContain("demo/acct-demo");
    expect(registry.getAdapter("demo", account.accountId)).toBeDefined();
  });

  test("explicit channel scope does not widen during reload", async () => {
    const registry = new ChannelRegistry();
    registry.setConfiguredChannelScope(["slack"], null);
    registry.setMessageHandler(() => {});
    registry.setReady();

    const summary = await registry.reloadConfiguredChannels();

    expect(summary.restarted).toEqual([]);
    expect(registry.getAdapter("demo", account.accountId)).toBeNull();
  });

  test("invalid refreshed account state leaves the old adapter running", async () => {
    const { registry } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    __testOverrideLoadChannelAccounts((channelId) => {
      if (channelId === "demo") throw new Error("invalid account store");
      return [];
    });

    await expect(registry.reloadConfiguredChannels()).rejects.toBeInstanceOf(
      ChannelInitializationError,
    );
    expect(registry.getAdapter("demo", account.accountId)).toBe(oldAdapter);
    expect(oldAdapter?.isRunning()).toBe(true);
  });

  test("approval replies pass through while ordinary ingress is buffered", async () => {
    const { registry } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const controlRequest: ChannelControlRequestEvent = {
      requestId: "request-during-reload",
      kind: "ask_user_question",
      source: {
        channel: "demo",
        accountId: account.accountId,
        chatId: "chat-demo",
        chatType: "direct",
        agentId: "agent-demo",
        conversationId: "conv-demo",
      },
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [
              { label: "Yes", description: "Continue the turn" },
              { label: "No", description: "Stop the turn" },
            ],
            multiSelect: false,
          },
        ],
      },
    };
    await registry.registerPendingControlRequest(controlRequest);
    let releaseReload: () => void = () => {};
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const reload = registry.reloadConfiguredChannels({
      beforeRestart: () => reloadGate,
    });

    await oldAdapter?.onMessage?.(inbound("1"));

    expect(approvalResponses).toHaveLength(1);
    expect(registry.hasPendingControlRequest(controlRequest.requestId)).toBe(
      false,
    );
    releaseReload();
    await reload;
  });

  test("coalesces requests and ACKs buffered ingress before ordered flush", async () => {
    const { registry, deliveredMessageIds } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    writePlugin("two");
    const completionOrder: string[] = [];
    registry.setMessageHandler((delivery) => {
      const messageId = delivery.turnSources?.[0]?.messageId ?? "missing";
      deliveredMessageIds.push(messageId);
      completionOrder.push(messageId);
    });

    let releaseDrain: () => void = () => {};
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let firstBeforeRestartCalls = 0;
    let secondBeforeRestartCalls = 0;
    const firstReload = registry.reloadConfiguredChannels({
      forceReloadPlugins: true,
      beforeRestart: async () => {
        firstBeforeRestartCalls += 1;
        await drain;
      },
      afterRestart: () => {
        completionOrder.push("after-restart");
      },
    });
    const secondReload = registry.reloadConfiguredChannels({
      forceReloadPlugins: true,
      beforeRestart: () => {
        secondBeforeRestartCalls += 1;
      },
    });

    expect(firstReload).toBe(secondReload);
    await oldAdapter?.onMessage?.(inbound("message-1"));
    await oldAdapter?.onMessage?.(inbound("message-2"));
    expect(deliveredMessageIds).toEqual([]);

    releaseDrain();
    const summary = await firstReload;

    expect(firstBeforeRestartCalls).toBe(1);
    expect(secondBeforeRestartCalls).toBe(1);
    expect(summary.bufferedDeliveries).toBe(2);
    expect(deliveredMessageIds).toEqual(["message-1", "message-2"]);
    expect(completionOrder).toEqual([
      "after-restart",
      "message-1",
      "message-2",
    ]);
    expect(registry.getAdapter("demo", account.accountId)?.name).toBe(
      "Demo two:unset",
    );
    expect(reloadTestGlobal.__lettaChannelReloadTestState?.events).toEqual([
      "start:one",
      "stop:one",
      "start:two",
    ]);
  });

  test("restores the previous adapter and plugin cache when restart fails", async () => {
    const { registry, deliveredMessageIds } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    const oldPlugin = await loadChannelPlugin("demo");
    loadedAccounts = [{ ...account, config: { version: "should-rollback" } }];
    loadedRoutes = [
      {
        accountId: account.accountId,
        chatId: "chat-demo",
        chatType: "direct",
        agentId: "agent-should-rollback",
        conversationId: "conv-should-rollback",
        enabled: true,
        createdAt: "2026-07-21T00:00:00.000Z",
      },
    ];
    writePlugin("two");
    const state = reloadTestGlobal.__lettaChannelReloadTestState;
    if (state) state.failStartGeneration = "two";

    await expect(
      registry.reloadConfiguredChannels({
        forceReloadPlugins: true,
        beforeRestart: async () => {
          await oldAdapter?.onMessage?.(inbound("during-failure"));
        },
      }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);

    expect(registry.getAdapter("demo", account.accountId)).toBe(oldAdapter);
    expect(oldAdapter?.isRunning()).toBe(true);
    expect(await loadChannelPlugin("demo")).toBe(oldPlugin);
    expect(listChannelAccounts("demo")).toMatchObject([
      { accountId: account.accountId, config: {} },
    ]);
    expect(
      registry.getRoute("demo", "chat-demo", account.accountId),
    ).toMatchObject({
      agentId: "agent-demo",
      conversationId: "conv-demo",
    });
    expect(deliveredMessageIds).toEqual(["during-failure"]);
    expect(state?.events).toEqual([
      "start:one",
      "stop:one",
      "start:two",
      "start:one",
    ]);
  });

  test("drain timeout leaves the old adapter running and flushes ingress", async () => {
    const { registry, deliveredMessageIds } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    const neverDrains = new Promise<void>(() => {});

    await expect(
      registry.reloadConfiguredChannels({
        timeoutMs: 10,
        beforeRestart: async () => {
          await oldAdapter?.onMessage?.(inbound("during-timeout"));
          await neverDrains;
        },
      }),
    ).rejects.toThrow("Timed out waiting for active channel turns");

    expect(registry.getAdapter("demo", account.accountId)).toBe(oldAdapter);
    expect(oldAdapter?.isRunning()).toBe(true);
    expect(deliveredMessageIds).toEqual(["during-timeout"]);
    expect(reloadTestGlobal.__lettaChannelReloadTestState?.events).toEqual([
      "start:one",
    ]);
  });

  test("adapter start timeout restores the old adapter deterministically", async () => {
    const { registry } = await createStartedRegistry();
    const oldAdapter = registry.getAdapter("demo", account.accountId);
    writePlugin("two");
    let releaseLateStart: () => void = () => {};
    const state = reloadTestGlobal.__lettaChannelReloadTestState;
    if (state) {
      state.hangStartGeneration = "two";
      state.startGate = new Promise<void>((resolve) => {
        releaseLateStart = resolve;
      });
    }

    await expect(
      registry.reloadConfiguredChannels({
        forceReloadPlugins: true,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);

    expect(registry.getAdapter("demo", account.accountId)).toBe(oldAdapter);
    expect(oldAdapter?.isRunning()).toBe(true);
    releaseLateStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.getAdapter("demo", account.accountId)).toBe(oldAdapter);
    expect(state?.events).toEqual([
      "start:one",
      "stop:one",
      "start:two",
      "start:one",
      "stop:two",
    ]);
  });

  test("coalesced requests that arrive during restart still run their hook", async () => {
    const { registry } = await createStartedRegistry();
    writePlugin("two");
    const state = reloadTestGlobal.__lettaChannelReloadTestState;
    let releaseStart: () => void = () => {};
    let observeStart: () => void = () => {};
    const startObserved = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    if (state) {
      state.hangStartGeneration = "two";
      state.startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      state.onStart = (generation) => {
        if (generation === "two") observeStart();
      };
    }

    const firstReload = registry.reloadConfiguredChannels({
      forceReloadPlugins: true,
    });
    await startObserved;
    loadedAccounts = [{ ...account, config: { version: "late" } }];
    let lateHookCalls = 0;
    const coalescedReload = registry.reloadConfiguredChannels({
      beforeRestart: () => {
        lateHookCalls += 1;
      },
    });
    expect(coalescedReload).toBe(firstReload);

    releaseStart();
    await coalescedReload;
    expect(lateHookCalls).toBe(1);
    expect(registry.getAdapter("demo", account.accountId)?.name).toBe(
      "Demo two:late",
    );
  });

  test("failed restart discards late coalesced hooks instead of leaking them", async () => {
    const { registry } = await createStartedRegistry();
    writePlugin("two");
    const state = reloadTestGlobal.__lettaChannelReloadTestState;
    let releaseStart: () => void = () => {};
    let observeStart: () => void = () => {};
    const startObserved = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    if (state) {
      state.hangStartGeneration = "two";
      state.startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      state.onStart = (generation) => {
        if (generation === "two") observeStart();
      };
    }

    const firstReload = registry.reloadConfiguredChannels({
      forceReloadPlugins: true,
      timeoutMs: 10,
    });
    await startObserved;
    let staleHookCalls = 0;
    const coalescedReload = registry.reloadConfiguredChannels({
      beforeRestart: () => {
        staleHookCalls += 1;
      },
    });
    await expect(firstReload).rejects.toBeInstanceOf(
      ChannelInitializationError,
    );
    await expect(coalescedReload).rejects.toBeInstanceOf(
      ChannelInitializationError,
    );
    expect(staleHookCalls).toBe(0);

    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let nextHookCalls = 0;
    await registry.reloadConfiguredChannels({
      beforeRestart: () => {
        nextHookCalls += 1;
      },
    });
    expect(staleHookCalls).toBe(0);
    expect(nextHookCalls).toBe(1);
  });
});
