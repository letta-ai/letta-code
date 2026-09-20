import { expect, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { INTERRUPT_RECOVERY_ALERT } from "@/agent/prompt-assets";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import type { StartListenerOptions } from "./types";
import { __listenerWarmupTestUtils } from "./warmup";

test("turn setup delivers the abort monitor notice once, only to the interrupted scope", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  const agentId = "agent-turn-setup-interrupt";
  const conversationId = "default";
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  __testSetBackend(
    new FakeHeadlessBackend(
      agentId,
      undefined,
      {},
      {
        modelHandle: "anthropic/claude-sonnet-4-6",
      },
    ),
  );
  // Keep remote MemFS/secrets hydration outside this local turn-setup fixture.
  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: directory.createDir("mods"),
    cacheDirectory: directory.createDir("cache"),
  });
  setActiveRuntime(listener);

  async function prepareInput(
    scopeAgentId: string,
    scopeConversationId: string,
  ) {
    const runtime = getOrCreateScopedRuntime(
      listener,
      scopeAgentId,
      scopeConversationId,
    );
    runtime.skillSources = [];
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    try {
      const result = await prepareListenerTurn({
        msg: {
          type: "message",
          agentId: scopeAgentId,
          conversationId: scopeConversationId,
          messages: [{ role: "user", content: "continue without monitors" }],
          clientToolset: { base: "default" },
        },
        runtime,
        agentId: scopeAgentId,
        conversationId: scopeConversationId,
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: lease,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("Turn setup was not ready");
      return result.turnInput.messages;
    } finally {
      finishListenerTurn(runtime, lease, {
        stopReason: "end_turn",
        socket,
        agentId: scopeAgentId,
        conversationId: scopeConversationId,
      });
    }
  }

  try {
    await settingsManager.initialize();
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    expect(
      await handleAbortMessageInput(listener, {
        command: {
          type: "abort_message",
          runtime: { agent_id: agentId, conversation_id: conversationId },
        },
        socket,
        opts: {} as StartListenerOptions,
        processQueuedTurn: async () => {},
      }),
    ).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket,
      agentId,
      conversationId,
    });
    // Backend cancellation is intentionally fire-and-forget; let its fence settle.
    await Bun.sleep(0);
    expect(runtime.turnLifecycle.kind).toBe("idle");

    for (const [otherAgent, otherConversation] of [
      [agentId, "other-conversation"],
      ["other-agent", conversationId],
    ] as const) {
      const messages = await prepareInput(otherAgent, otherConversation);
      expect(JSON.stringify(messages)).not.toContain(
        INTERRUPT_RECOVERY_ALERT.trim(),
      );
    }

    const messages = await prepareInput(agentId, conversationId);
    const serialized = JSON.stringify(messages);
    expect(serialized.split(INTERRUPT_RECOVERY_ALERT.trim())).toHaveLength(2);
    expect(serialized).toContain("Do not restart them unless the user asks.");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(messages[0])).toContain(
      INTERRUPT_RECOVERY_ALERT.trim(),
    );
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "continue without monitors",
    });
    const laterMessages = await prepareInput(agentId, conversationId);
    expect(JSON.stringify(laterMessages)).not.toContain(
      INTERRUPT_RECOVERY_ALERT.trim(),
    );
    expect(laterMessages).toHaveLength(1);
  } finally {
    disposeListenerModAdapter(listener);
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
    __listenerModAdapterTestUtils.resetForTests();
    clearCapturedToolExecutionContexts();
    setActiveRuntime(null);
    setCurrentAgentId(null);
    setCurrentAgentName(null);
    setConversationId(null);
    __testSetBackend(null);
    await settingsManager.reset();
    restoreEnv();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    directory.cleanup();
  }
});
