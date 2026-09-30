import { expect, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { getStoredClientPreferences } from "@/tools/client-preferences";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { parseServerMessage } from "./protocol-inbound";
import { evictConversationRuntimeIfIdle, setActiveRuntime } from "./runtime";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import { __listenerWarmupTestUtils } from "./warmup";

test("conversation preferences preserve serialized tools across idle, automatic turns, eviction and settings reload", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  const agentId = "agent-question-input";
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
  listener.modAdapter = createListenerModAdapter({
    globalModsDirectory: directory.createDir("mods"),
    cacheDirectory: directory.createDir("cache"),
  });
  setActiveRuntime(listener);
  const socket = {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  try {
    await settingsManager.initialize();
    async function prepare(
      conversationId: string,
      payload: Partial<InputCreateMessagePayload> = {},
    ) {
      const parsed = parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "input",
            runtime: { agent_id: agentId, conversation_id: conversationId },
            payload: {
              kind: "create_message",
              messages: [{ role: "user", content: "Which warehouse?" }],
              ...payload,
            },
          }),
        ),
      );
      if (parsed?.type !== "input" || parsed.payload.kind !== "create_message")
        throw new Error("Input did not parse");
      const runtime = getOrCreateScopedRuntime(
        listener,
        agentId,
        conversationId,
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
            agentId,
            conversationId,
            messages: parsed.payload.messages,
            clientToolset: parsed.payload.client_toolset,
            clientPreferences: parsed.payload.client_preferences,
            excludeInteractiveTools: parsed.payload.exclude_interactive_tools,
          },
          runtime,
          agentId,
          conversationId,
          workingDirectory: directory.path,
          permissionModeState: { mode: "standard" },
          turnLease: lease,
        });
        if (result.kind !== "ready") throw new Error("Turn did not prepare");
        return JSON.stringify(
          result.preparedToolContext.preparedToolContext.clientTools,
        );
      } finally {
        finishListenerTurn(runtime, lease, {
          stopReason: "end_turn",
          socket,
          agentId,
          conversationId,
        });
      }
    }
    const name = '"name":"AskUserQuestion"';
    const baseline = await prepare("web");
    const preferences = { toolset: { include: ["AskUserQuestion"] } };
    const included = await prepare("web", { client_preferences: preferences });
    expect(included).toContain(name);
    expect(
      await prepare("web", {
        messages: [
          {
            role: "user",
            content: "<task-notification>done</task-notification>",
          },
        ],
      }),
    ).toBe(included);
    expect(
      await prepare("web", {
        messages: [{ role: "user", content: "scheduled prompt" }],
      }),
    ).toBe(included);
    expect(await prepare("web", { client_preferences: preferences })).toBe(
      included,
    );
    const oldRuntime = getOrCreateScopedRuntime(listener, agentId, "web");
    expect(evictConversationRuntimeIfIdle(oldRuntime)).toBe(true);
    expect(getOrCreateScopedRuntime(listener, agentId, "web")).not.toBe(
      oldRuntime,
    );
    expect(await prepare("web")).toBe(included);
    await settingsManager.reset();
    await settingsManager.initialize();
    expect(await prepare("web")).toBe(included);
    expect(await prepare("child")).not.toContain(name);
    expect(await prepare("web", { client_toolset: {} })).toBe(baseline);
    expect(await prepare("web")).toBe(included);
    expect(await prepare("web", { exclude_interactive_tools: true })).toBe(
      baseline,
    );
    expect(await prepare("web")).toBe(included);
    expect(await prepare("web", { client_preferences: {} })).toBe(baseline);
    expect(await prepare("web")).toBe(baseline);
    expect(
      await prepare("web", {
        client_toolset: { include: ["AskUserQuestion"] },
      }),
    ).toContain(name);
    expect(await prepare("web")).toBe(baseline);
    expect(getStoredClientPreferences(agentId, "web")).toEqual({});
    await prepare("default", { client_preferences: preferences });
    expect(await prepare("default")).toContain(name);
    expect(await prepare("other")).not.toContain(name);
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
