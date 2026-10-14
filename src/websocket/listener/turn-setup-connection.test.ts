import { expect, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import {
  clearCapturedToolExecutionContexts,
  getExecutionContextById,
} from "@/tools/manager";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
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

// Task notifications, cron and mod continues reach a turn with no submitting
// connection. Agent launches in that turn read the tool context's connectionId;
// without it the child runs as a direct-API process no listener owns.
test("turn setup carries the listener connection and global mods into agent-free workers", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  const agentId = "agent-process-turn-connection";
  const conversationId = "default";
  const writer: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId: "conn-sandbox",
    writer,
    options: {
      connectionId: "conn-sandbox",
      wsUrl: "local://test",
      deviceId: "test-device",
      connectionName: "conn-sandbox",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  markListenerConnectionInitialized(listener, "conn-sandbox");
  __testSetBackend(
    new FakeHeadlessBackend(
      agentId,
      undefined,
      {},
      { modelHandle: "anthropic/claude-sonnet-4-6" },
    ),
  );
  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  const globalModsDirectory = directory.createDir("mods");
  directory.createFile(
    "mods/council.ts",
    `export default function activate(letta) {
      return letta.tools.register({
        name: "council_web_search",
        description: "search",
        parameters: { type: "object", properties: {} },
        requiresApproval: false,
        run() { return "council_web_search ok"; },
      });
    }`,
  );
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory,
    cacheDirectory: directory.createDir("cache"),
  });
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  runtime.skillSources = [];
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: directory.path,
  });

  try {
    await settingsManager.initialize();
    await listener.modAdapter.reload();
    const result = await prepareListenerTurn({
      msg: {
        type: "message",
        agentId,
        conversationId,
        messages: [{ role: "user", content: "<task-notification/>" }],
        clientToolset: { base: "default" },
      },
      runtime,
      agentId,
      conversationId,
      workingDirectory: directory.path,
      permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
      turnLease: lease,
      // No connectionId: this is how process-originated queued turns arrive.
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Turn setup was not ready");
    const contextId = result.preparedToolContext.preparedToolContext.contextId;
    expect(
      getExecutionContextById(contextId)?.runtimeContext.connectionId,
    ).toBe("conn-sandbox");

    const worker = getOrCreateScopedRuntime(listener, null, "default");
    worker.skillSources = [];
    const workerLease = worker.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    try {
      const workerResult = await prepareListenerTurn({
        msg: {
          type: "message",
          agentId: null,
          conversationId: "default",
          messages: [{ role: "user", content: "search" }],
          clientToolset: { base: "none", include: [] },
          clientToolAllowlist: ["council_web_search"],
        },
        runtime: worker,
        agentId: null,
        conversationId: "default",
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: workerLease,
      });
      expect(workerResult.kind).toBe("ready");
      if (workerResult.kind !== "ready") {
        throw new Error("Agent-free worker turn setup was not ready");
      }
      expect(
        workerResult.preparedToolContext.preparedToolContext.clientTools.map(
          (tool) => tool.name,
        ),
      ).toEqual(["council_web_search"]);
    } finally {
      finishListenerTurn(worker, workerLease, {
        stopReason: "end_turn",
        socket: writer,
        agentId: null,
        conversationId: "default",
      });
    }
  } finally {
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      socket: writer,
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
