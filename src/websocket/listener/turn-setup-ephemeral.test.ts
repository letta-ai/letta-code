import { expect, spyOn, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  sendAgentMessageFixture,
  TARGET_CONV,
} from "@/test-utils/send-agent-message-fixture";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { send_agent_message } from "@/tools/impl/send-agent-message";
import { getShellEnv } from "@/tools/impl/shell-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
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
import { __listenerWarmupTestUtils } from "./warmup";

test("agentless follow-up turn exports sender identity and replies to its parent", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  const agentId = "agent-turn-setup-interrupt";
  const conversationId = "conv-11111111-1111-4111-8111-111111111111";
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  const backend = new FakeHeadlessBackend(
    agentId,
    undefined,
    {},
    {
      modelHandle: "anthropic/claude-sonnet-4-6",
    },
  );
  __testSetBackend(backend);
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

  const lookup = spyOn(backend, "retrieveConversation").mockResolvedValue({
    id: conversationId,
    agent_id: null,
    is_subagent: true,
    parent_agent_id: agentId,
    parent_conversation_id: TARGET_CONV,
    model: "anthropic/claude-sonnet-4-6",
  } as never);
  try {
    await settingsManager.initialize();
    const runtime = getOrCreateScopedRuntime(listener, null, conversationId);
    runtime.skillSources = [];
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    await runWithRuntimeContext({ agentId: null, conversationId }, async () => {
      const result = await prepareListenerTurn({
        msg: {
          type: "message",
          agentId: null,
          conversationId,
          messages: [{ role: "user", content: "follow up" }],
          clientToolset: { base: "default" },
        },
        runtime,
        agentId: null,
        conversationId,
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: lease,
      });
      expect(result.kind).toBe("ready");
      expect(getShellEnv().AGENT_ID).toBe(agentId);
      expect(getShellEnv().CONVERSATION_ID).toBe(conversationId);
      const f = sendAgentMessageFixture();
      expect(
        (await send_agent_message({ message: "Follow-up done" }, f)).status,
      ).toBe("success");
      expect(f.submissions[0]?.conversationId).toBe(TARGET_CONV);
      expect(JSON.stringify(f.submissions[0]?.content)).toContain(
        `This message is from agent ${agentId}, conversation ${conversationId}`,
      );
    });
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      socket,
      agentId: null,
      conversationId,
    });
  } finally {
    lookup.mockRestore();
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
