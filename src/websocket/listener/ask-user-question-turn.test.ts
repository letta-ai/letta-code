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
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { parseServerMessage } from "./protocol-inbound";
import { setActiveRuntime } from "./runtime";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import { __listenerWarmupTestUtils } from "./warmup";

test("app-server questions are scoped to the input that includes them", async () => {
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
      include: boolean,
      exclude = false,
    ) {
      const parsed = parseServerMessage(
        Buffer.from(
          JSON.stringify({
            type: "input",
            runtime: { agent_id: agentId, conversation_id: conversationId },
            payload: {
              kind: "create_message",
              messages: [{ role: "user", content: "Which warehouse?" }],
              ...(include
                ? { client_toolset: { include: ["AskUserQuestionAsync"] } }
                : {}),
              exclude_interactive_tools: exclude,
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
        return result.preparedToolContext.preparedToolContext.clientTools.map(
          (tool) => tool.name,
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
    expect(await prepare("web", true)).toContain("AskUserQuestion");
    expect(await prepare("child", false)).not.toContain("AskUserQuestion");
    expect(await prepare("web", false)).not.toContain("AskUserQuestion");
    expect(await prepare("web", true, true)).not.toContain("AskUserQuestion");
    expect(await prepare("web", true)).toContain("AskUserQuestion");
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
