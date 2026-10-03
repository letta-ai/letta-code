import { expect, test } from "bun:test";
import { join } from "node:path";
import type WebSocket from "ws";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { __agentModOverridesTestUtils } from "@/mods/agent-mod-overrides";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { handleExecuteCommand } from "./commands";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { SUPPORTED_REMOTE_COMMANDS } from "./listener-constants";
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

// LET-12868, through the managed listener path: a MemFS turn_start guard
// cancels every message turn; the user recovers with the remote `/mods`
// command (execute_command), which never runs a guarded turn.

const GUARD = `export default function activate(letta) {
  letta.events.on("turn_start", () => ({
    cancel: { reason: "bootstrap failed; turn cancelled to prevent wrong-identity attribution" },
  }));
}`;

test("listener: guard locks out every turn until /mods disable, then turns resume", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  const agentId = "agent-lockout-repro";
  const conversationId = "default";
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  const modsDirectory = directory.createDir("agent-memory/mods");
  directory.createFile("agent-memory/mods/identity-guard.ts", GUARD);

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
    async () => true,
  );
  __listenerModAdapterTestUtils.setAgentModsDirectoryResolverForTests(
    () => modsDirectory,
  );
  __listenerModAdapterTestUtils.setAgentModCacheDirectoryResolverForTests(() =>
    directory.createDir("agent-cache"),
  );
  __agentModOverridesTestUtils.setRootForTests(
    join(directory.path, "overrides"),
  );
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: directory.createDir("global-mods"),
    cacheDirectory: directory.createDir("cache"),
  });
  setActiveRuntime(listener);

  async function sendTurn(text: string) {
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    runtime.skillSources = [];
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    try {
      return await prepareListenerTurn({
        msg: {
          type: "message",
          agentId,
          conversationId,
          messages: [{ role: "user", content: text }],
          clientToolset: { base: "default" },
        },
        runtime,
        agentId,
        conversationId,
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: lease,
      });
    } finally {
      finishListenerTurn(runtime, lease, {
        stopReason: "end_turn",
        socket,
        agentId,
        conversationId,
      });
    }
  }

  async function runModsCommand(args: string) {
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    const sent: string[] = [];
    await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: "mods",
        args,
        request_id: `mods-${args}`,
        runtime: {
          agent_id: agentId,
          conversation_id: conversationId,
          acting_user_id: "user-owner",
        },
      },
      {
        readyState: 1,
        send: (value: string) => sent.push(value),
      } as unknown as WebSocket,
      runtime,
      {},
    );
    return JSON.parse(sent[sent.length - 1] ?? "{}") as {
      success: boolean;
      output: string;
    };
  }

  try {
    await settingsManager.initialize();
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("mods");

    for (const text of ["Ping", "Ping again"]) {
      const result = await sendTurn(text);
      expect(result.kind).toBe("cancelled");
      if (result.kind !== "cancelled") throw new Error("expected cancel");
      expect(result.reason).toContain("identity-guard.ts");
      expect(result.reason).toContain("/mods disable identity-guard.ts");
    }

    const disabled = await runModsCommand("disable identity-guard.ts");
    expect(disabled).toMatchObject({ success: true });

    for (const text of ["Ping", "Ping again"]) {
      expect((await sendTurn(text)).kind).toBe("ready");
    }

    const listed = await runModsCommand("list");
    expect(listed.output).toContain("disabled  identity-guard.ts");
    expect(listed.output).toContain("user-owner");
  } finally {
    disposeListenerModAdapter(listener);
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
    __listenerModAdapterTestUtils.resetForTests();
    __agentModOverridesTestUtils.setRootForTests(null);
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
