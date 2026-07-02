import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureBackendMode, getBackend } from "@/backend";
import { LOCAL_BACKEND_DIR_ENV } from "@/backend/local/paths";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";

function signalInbound(
  overrides: Partial<InboundChannelMessage> = {},
): InboundChannelMessage {
  return {
    channel: "signal",
    accountId: "personal",
    chatId: "signal:+15555550123",
    senderId: "+15555550123",
    senderName: "Cameron",
    text: "hello from signal",
    timestamp: Date.now(),
    messageId: "123:+15555550123",
    threadId: null,
    chatType: "direct",
    ...overrides,
  };
}

function createAdapter(): ChannelAdapter {
  return {
    id: "signal:personal",
    channelId: "signal",
    accountId: "personal",
    name: "Signal",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "outbound-1" }),
    sendDirectReply: async () => {},
  };
}

function createPreparingAdapter(): ChannelAdapter {
  return {
    ...createAdapter(),
    prepareInboundMessage: async (msg) => ({
      ...msg,
      attachments: [
        {
          kind: "audio",
          localPath: "/tmp/signal-voice.aac",
          name: "signal-voice.aac",
          mimeType: "audio/aac",
          transcriptionError: "install ffmpeg to transcribe Signal AAC audio",
        },
      ],
    }),
  };
}

describe("signal channel registry", () => {
  let localBackendDir: string | null = null;
  const previousLocalBackendDir = process.env[LOCAL_BACKEND_DIR_ENV];
  const previousLocalBackendNoMemfs = process.env.LETTA_LOCAL_BACKEND_NO_MEMFS;
  const previousLocalBackendExecutor = process.env.LETTA_LOCAL_BACKEND_EXECUTOR;

  beforeEach(() => {
    localBackendDir = mkdtempSync(join(tmpdir(), "signal-registry-local-"));
    process.env[LOCAL_BACKEND_DIR_ENV] = localBackendDir;
    process.env.LETTA_LOCAL_BACKEND_NO_MEMFS = "1";
    process.env.LETTA_LOCAL_BACKEND_EXECUTOR = "deterministic";
    configureBackendMode("local");

    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  });

  afterEach(async () => {
    const { getChannelRegistry } = await import("@/channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
    configureBackendMode("api");
    if (previousLocalBackendDir === undefined) {
      delete process.env[LOCAL_BACKEND_DIR_ENV];
    } else {
      process.env[LOCAL_BACKEND_DIR_ENV] = previousLocalBackendDir;
    }
    if (previousLocalBackendNoMemfs === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_NO_MEMFS;
    } else {
      process.env.LETTA_LOCAL_BACKEND_NO_MEMFS = previousLocalBackendNoMemfs;
    }
    if (previousLocalBackendExecutor === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_EXECUTOR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_EXECUTOR = previousLocalBackendExecutor;
    }
    if (localBackendDir) {
      rmSync(localBackendDir, { recursive: true, force: true });
      localBackendDir = null;
    }
  });

  test("open Signal DMs auto-route through the local backend", async () => {
    const agent = await getBackend().createAgent({ name: "Signal Test Agent" });
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "signal",
        accountId: "personal",
        displayName: "Signal",
        enabled: true,
        baseUrl: "http://127.0.0.1:8080",
        account: "+15555550100",
        accountUuid: "self-uuid",
        dmPolicy: "open",
        allowedUsers: [],
        agentId: agent.id,
        selfChatMode: false,
        groupMode: "disabled",
        allowedGroups: [],
        mentionPatterns: [],
        downloadMedia: false,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(signalInbound());

    const route = getRoute("signal", "signal:+15555550123", "personal");
    expect(route).toMatchObject({
      accountId: "personal",
      chatId: "signal:+15555550123",
      chatType: "direct",
      agentId: agent.id,
      enabled: true,
    });
    expect(route?.conversationId.startsWith("local-conv-")).toBe(true);
    expect(deliveries).toHaveLength(1);
  });

  test("paired Signal routes prepare inbound messages before delivery", async () => {
    const agent = await getBackend().createAgent({
      name: "Signal Route Agent",
    });
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "signal",
        accountId: "personal",
        displayName: "Signal",
        enabled: true,
        baseUrl: "http://127.0.0.1:8080",
        account: "+15555550100",
        accountUuid: "self-uuid",
        dmPolicy: "pairing",
        allowedUsers: ["+15555550123"],
        agentId: agent.id,
        selfChatMode: false,
        groupMode: "disabled",
        allowedGroups: [],
        mentionPatterns: [],
        transcribeVoice: true,
        downloadMedia: true,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      },
    ]);
    __testOverrideLoadPairingStore(() => ({
      pending: [],
      approved: [
        {
          accountId: "personal",
          senderId: "+15555550123",
          senderName: "Cameron",
          approvedAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    }));
    addRoute("signal", {
      accountId: "personal",
      chatId: "signal:+15555550123",
      chatType: "direct",
      threadId: null,
      agentId: agent.id,
      conversationId: "default",
      enabled: true,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createPreparingAdapter();
    registry.registerAdapter(adapter);

    const deliveries: Array<{ content?: unknown }> = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(signalInbound({ text: "[audio attached]" }));

    expect(deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveries[0]?.content)).toContain(
      "install ffmpeg to transcribe Signal AAC audio",
    );
    expect(JSON.stringify(deliveries[0]?.content)).toContain(
      "attempted_transcription_error",
    );
  });
});
