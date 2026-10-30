import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
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

// Cloud listeners deliver a subagent's role and parent as per-turn execution
// settings rather than process env. Reminders must resolve the MCP scope from
// those settings, matching what `letta mcp list` sees in the shell.
test("turn setup reminders resolve a subagent's MCP scope from runtime execution settings", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  expect(process.env.LETTA_CODE_AGENT_ROLE).toBeUndefined();
  expect(process.env.LETTA_PARENT_AGENT_ID).toBeUndefined();
  const listener = createRuntime();
  const agentId = "agent-turn-setup-subagent";
  const parentAgentId = "agent-turn-setup-parent";
  const conversationId = "default";
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
    { modelHandle: "anthropic/claude-sonnet-4-6" },
  );
  const retrieveAgent = backend.retrieveAgent.bind(backend);
  backend.retrieveAgent = async (id: string) => {
    const agent = await retrieveAgent(id);
    return id === agentId
      ? { ...agent, tags: ["role:subagent", `parent:${parentAgentId}`] }
      : agent;
  };
  __testSetBackend(backend);
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
  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  runtime.skillSources = [];
  runtime.executionSettings = {
    allowed_tools: [],
    disallowed_tools: [],
    disable_memory_guard: false,
    agent_role: "subagent",
    parent_agent_id: parentAgentId,
  };
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: directory.path,
  });

  try {
    await settingsManager.initialize();
    settingsManager.setMcpServers(parentAgentId, [
      { name: "parent-filesystem", command: "true" },
    ]);
    // The agent-info reminder names the parent only when its memory exists.
    mkdirSync(getScopedMemoryFilesystemRoot(parentAgentId), {
      recursive: true,
    });
    const result = await prepareListenerTurn({
      msg: {
        type: "message",
        agentId,
        conversationId,
        messages: [{ role: "user", content: "list your mcp servers" }],
        clientToolset: { base: "default" },
      },
      runtime,
      agentId,
      conversationId,
      workingDirectory: directory.path,
      permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
      turnLease: lease,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Turn setup was not ready");
    const content = JSON.stringify(result.turnInput.messages);
    expect(content).toContain(
      "MCP servers with available tools: parent-filesystem",
    );
    expect(content).toContain(`Your parent agent (${parentAgentId})`);
  } finally {
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      socket,
      agentId,
      conversationId,
    });
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
