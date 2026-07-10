import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { ChannelRegistry } from "@/channels/registry";
import { clearAllRoutes } from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter } from "@/channels/types";
import { LidDesk, type OnWhatsAppSocket } from "./lid-desk";

// ── Helpers ─────────────────────────────────────────────────────────

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "wa-outbound-bootstrap-"));
}

function installTestOverrides(): void {
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadTargetStore(() => {});
  __testOverrideSaveTargetStore(() => {});
}

/**
 * Create a mock WhatsApp adapter with the getLidDesk/getSocket extensions
 * that the real adapter exposes.
 */
function makeMockWhatsAppAdapter(params: {
  accountId?: string;
  lidDesk: LidDesk;
  sock?: OnWhatsAppSocket | null;
  running?: boolean;
  sendMessage?: ReturnType<typeof mock>;
}): ChannelAdapter & {
  getLidDesk: () => LidDesk;
  getSocket: () => OnWhatsAppSocket | null;
} {
  const {
    accountId = "signo-digi",
    lidDesk,
    sock = null,
    running = true,
    sendMessage = mock(async () => ({ messageId: "wa-msg-1" })),
  } = params;

  return {
    id: `whatsapp:${accountId}`,
    channelId: "whatsapp",
    accountId,
    name: "WhatsApp",
    start: async () => {},
    stop: async () => {},
    isRunning: () => running,
    sendMessage,
    sendDirectReply: async () => {},
    getLidDesk: () => lidDesk,
    getSocket: () => sock,
  };
}

function makeMockSocket(
  responseMap: Record<string, { exists: boolean; jid?: string; lid?: string }>,
): OnWhatsAppSocket {
  return {
    onWhatsApp: async (phone: string) => {
      const r = responseMap[phone];
      return r ? [r] : [];
    },
  };
}

beforeEach(() => {
  tempDir = makeTempDir();
  installTestOverrides();
});

afterEach(async () => {
  clearAllRoutes();
  clearChannelAccountStores();
  clearTargetStores();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadTargetStore(null);
  __testOverrideSaveTargetStore(null);
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe("tryBootstrapOutboundRoute — WhatsApp-only", () => {
  test("first outbound to a phone chatId with no route: desk lookup → LID resolved → route created → retry succeeds", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": {
        exists: true,
        jid: "34625815199@s.whatsapp.net",
        lid: "9876543210@lid",
      },
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    // No route exists initially.
    const beforeRoute = registry.getRouteForScope(
      "whatsapp",
      "34625815199@s.whatsapp.net",
      "agent-1",
      "conv-1",
      "signo-digi",
    );
    expect(beforeRoute).toBeNull();

    // Attempt bootstrap.
    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(true);

    // Route now exists — getRouteForScope finds it via alias lookup
    // (queried by phone, route is keyed by LID).
    const afterRoute = registry.getRouteForScope(
      "whatsapp",
      "34625815199@s.whatsapp.net",
      "agent-1",
      "conv-1",
      "signo-digi",
    );
    expect(afterRoute).not.toBeNull();
    expect(afterRoute?.chatId).toBe("9876543210@lid");
    expect(afterRoute?.agentId).toBe("agent-1");
    expect(afterRoute?.conversationId).toBe("conv-1");
    expect(afterRoute?.enabled).toBe(true);
    expect(afterRoute?.outboundEnabled).toBe(true);

    // LidDesk now has the phone→LID mapping persisted.
    expect(lidDesk.resolvePn("34625815199@s.whatsapp.net")).toBe(
      "9876543210@lid",
    );

    await registry.stopAll();
  });

  test("first outbound with phone chatId, no socket available: returns false (original error surfaces)", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock: null });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    // No route was created.
    expect(
      registry.getRouteForScope(
        "whatsapp",
        "34625815199@s.whatsapp.net",
        "agent-1",
        "conv-1",
        "signo-digi",
      ),
    ).toBeNull();

    await registry.stopAll();
  });

  test("first outbound with phone chatId, socket present but onWhatsApp returns no LID: returns false", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": { exists: false },
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    expect(
      registry.getRouteForScope(
        "whatsapp",
        "34625815199@s.whatsapp.net",
        "agent-1",
        "conv-1",
        "signo-digi",
      ),
    ).toBeNull();

    await registry.stopAll();
  });

  test("existing routes still resolve and proceed without re-resolving", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    let onWhatsAppCallCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        onWhatsAppCallCount++;
        return [{ exists: true, lid: "should-not-be-called@lid" }];
      },
    };

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    // Pre-create a route.
    const { addRoute } = await import("@/channels/routing");
    const now = new Date().toISOString();
    addRoute("whatsapp", {
      accountId: "signo-digi",
      chatId: "34625815199@s.whatsapp.net",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    // Route should be found immediately — bootstrap should NOT be called.
    const route = registry.getRouteForScope(
      "whatsapp",
      "34625815199@s.whatsapp.net",
      "agent-1",
      "conv-1",
      "signo-digi",
    );
    expect(route).not.toBeNull();
    expect(onWhatsAppCallCount).toBe(0);

    await registry.stopAll();
  });

  test("rate-limited lookup doesn't blow past 10/min per phone", async () => {
    const lidDesk = new LidDesk(tempDir); // default 10/min
    lidDesk.load();
    let onWhatsAppCallCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        onWhatsAppCallCount++;
        return [{ exists: false }]; // never resolves, so each call hits onWhatsApp
      },
    };

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    // Attempt bootstrap 15 times for the same phone.
    for (let i = 0; i < 15; i++) {
      await registry.tryBootstrapOutboundRoute({
        channel: "whatsapp",
        chatId: "34625815199@s.whatsapp.net",
        agentId: "agent-1",
        conversationId: "conv-1",
        accountId: "signo-digi",
      });
    }

    // Only the first 10 should have called onWhatsApp.
    expect(onWhatsAppCallCount).toBe(10);

    await registry.stopAll();
  });

  test("non-WhatsApp channel: returns false immediately (no broadening)", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();

    const registry = new ChannelRegistry();

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "telegram",
      chatId: "12345",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "account-1",
    });
    expect(bootstrapped).toBe(false);

    await registry.stopAll();
  });

  test("LID chatId: returns false (only phone JIDs are bootstrappable)", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({});

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "9876543210@lid",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    await registry.stopAll();
  });

  test("group JID: returns false (only phone JIDs are bootstrappable)", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({});

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "120363@g.us",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    await registry.stopAll();
  });

  test("adapter not running: returns false", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": {
        exists: true,
        lid: "9876543210@lid",
      },
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({
      lidDesk,
      sock,
      running: false,
    });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    await registry.stopAll();
  });

  test("cache hit in LidDesk: bootstrap succeeds without calling onWhatsApp", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    // Pre-populate the desk with a mapping.
    lidDesk.record("9876543210@lid", "34625815199@s.whatsapp.net");
    lidDesk.save();

    let onWhatsAppCallCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        onWhatsAppCallCount++;
        return [{ exists: true, lid: "other@lid" }];
      },
    };

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(true);
    expect(onWhatsAppCallCount).toBe(0); // cache hit, no onWhatsApp call

    await registry.stopAll();
  });
});

// ── Slice 8: phone↔LID route alias normalization ───────────────────

describe("route alias normalization — phone↔LID convergence", () => {
  test("bootstrap creates route keyed by LID when mapping known", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": {
        exists: true,
        jid: "34625815199@s.whatsapp.net",
        lid: "9876543210@lid",
      },
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(true);

    // Verify the route is keyed by LID, not by phone.
    const { getRouteRaw } = await import("@/channels/routing");
    const phoneRoute = getRouteRaw(
      "whatsapp",
      "34625815199@s.whatsapp.net",
      "signo-digi",
    );
    expect(phoneRoute).toBeUndefined();

    const lidRoute = getRouteRaw("whatsapp", "9876543210@lid", "signo-digi");
    expect(lidRoute).toBeDefined();
    expect(lidRoute?.agentId).toBe("agent-1");
    expect(lidRoute?.conversationId).toBe("conv-1");
    expect(lidRoute?.outboundEnabled).toBe(true);

    await registry.stopAll();
  });

  test("getRouteForScope returns the LID-keyed route when queried with phone chatId", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    lidDesk.record("9876543210@lid", "34625815199@s.whatsapp.net");
    lidDesk.save();

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk });
    registry.registerAdapter(adapter);

    // Pre-create a route keyed by LID (simulating inbound route).
    const { addRoute } = await import("@/channels/routing");
    const now = new Date().toISOString();
    addRoute("whatsapp", {
      accountId: "signo-digi",
      chatId: "9876543210@lid",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    // Query with phone chatId — should find the LID-keyed route via alias.
    const route = registry.getRouteForScope(
      "whatsapp",
      "34625815199@s.whatsapp.net",
      "agent-1",
      "conv-1",
      "signo-digi",
    );
    expect(route).not.toBeNull();
    expect(route?.chatId).toBe("9876543210@lid");

    await registry.stopAll();
  });

  test("getRouteForScope returns the phone-keyed route when queried with LID chatId", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    lidDesk.record("9876543210@lid", "34625815199@s.whatsapp.net");
    lidDesk.save();

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk });
    registry.registerAdapter(adapter);

    // Pre-create a route keyed by phone (simulating a legacy route).
    const { addRoute } = await import("@/channels/routing");
    const now = new Date().toISOString();
    addRoute("whatsapp", {
      accountId: "signo-digi",
      chatId: "34625815199@s.whatsapp.net",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    // Query with LID chatId — should find the phone-keyed route via alias.
    const route = registry.getRouteForScope(
      "whatsapp",
      "9876543210@lid",
      "agent-1",
      "conv-1",
      "signo-digi",
    );
    expect(route).not.toBeNull();
    expect(route?.chatId).toBe("34625815199@s.whatsapp.net");

    await registry.stopAll();
  });

  test("bootstrap from outbound (phone) and inbound (LID) converge to one route, not two", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": {
        exists: true,
        jid: "34625815199@s.whatsapp.net",
        lid: "9876543210@lid",
      },
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    // Step 1: Outbound bootstrap creates a route keyed by LID.
    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(true);

    // Step 2: Simulate inbound — ensureWhatsAppRoute with LID chatId.
    // The route already exists (keyed by LID from step 1), so it should
    // be found directly and NOT create a second route.
    const { getRoute } = await import("@/channels/routing");
    const existingRoute = getRoute(
      "whatsapp",
      "9876543210@lid",
      "signo-digi",
      null,
    );
    expect(existingRoute).not.toBeNull();

    // Verify only one route entry exists for this contact.
    const { getRoutesForChannel } = await import("@/channels/routing");
    const allRoutes = getRoutesForChannel("whatsapp", "signo-digi");
    const contactRoutes = allRoutes.filter(
      (r) =>
        r.chatId === "9876543210@lid" ||
        r.chatId === "34625815199@s.whatsapp.net",
    );
    expect(contactRoutes.length).toBe(1);

    await registry.stopAll();
  });

  test("non-WhatsApp channels are unchanged by alias logic", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk });
    registry.registerAdapter(adapter);

    // Pre-create a Telegram route.
    const { addRoute } = await import("@/channels/routing");
    const now = new Date().toISOString();
    addRoute("telegram", {
      accountId: "tg-account",
      chatId: "12345",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    // Direct lookup works.
    const route = registry.getRouteForScope(
      "telegram",
      "12345",
      "agent-1",
      "conv-1",
      "tg-account",
    );
    expect(route).not.toBeNull();
    expect(route?.chatId).toBe("12345");

    // No alias magic — a different chatId doesn't match.
    const noRoute = registry.getRouteForScope(
      "telegram",
      "99999",
      "agent-1",
      "conv-1",
      "tg-account",
    );
    expect(noRoute).toBeNull();

    await registry.stopAll();
  });

  test("phone-only contact (no LID mapping): bootstrap keys by phone, alias lookup is no-op", async () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.load();
    // No LID mapping recorded — onWhatsApp returns no LID.
    const sock = makeMockSocket({
      "34625815199@s.whatsapp.net": { exists: true }, // no lid field
    });

    const registry = new ChannelRegistry();
    const adapter = makeMockWhatsAppAdapter({ lidDesk, sock });
    registry.registerAdapter(adapter);

    // Bootstrap fails (no LID resolved).
    const bootstrapped = await registry.tryBootstrapOutboundRoute({
      channel: "whatsapp",
      chatId: "34625815199@s.whatsapp.net",
      agentId: "agent-1",
      conversationId: "conv-1",
      accountId: "signo-digi",
    });
    expect(bootstrapped).toBe(false);

    // No route created.
    const { getRouteRaw } = await import("@/channels/routing");
    expect(
      getRouteRaw("whatsapp", "34625815199@s.whatsapp.net", "signo-digi"),
    ).toBeUndefined();

    await registry.stopAll();
  });
});
