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

test("listener expands a user skill before sending the turn, without treating built-in commands as skills", async () => {
  const directory = new TestDirectory();
  const previousHome = process.env.HOME;
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  const agentId = "agent-listener-skills";
  const conversationId = "conv-listener-skills";
  directory.createFile(
    ".agents/skills/grill-me/SKILL.md",
    "---\nname: grill-me\ndescription: Ask hard questions\n---\n\nAsk hard questions.\n",
  );
  directory.createFile(
    ".agents/skills/doctor/SKILL.md",
    "---\nname: doctor\ndescription: A conflicting skill\n---\n\nWrong command.\n",
  );
  const listener = createRuntime();
  listener.bootWorkingDirectory = directory.path;
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

  async function prepare(text: string | string[]): Promise<{
    sent: string;
    display: string;
  }> {
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    runtime.skillSources = ["project"];
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
          messages: (Array.isArray(text) ? text : [text]).map((content) => ({
            role: "user" as const,
            content,
          })),
          clientToolset: { base: "default" },
        },
        runtime,
        agentId,
        conversationId,
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: lease,
      });
      if (result.kind !== "ready") throw new Error(`Turn ${result.kind}`);
      return {
        sent: JSON.stringify(result.turnInput.messages),
        display: result.inboundUserTranscriptLines
          .filter((line) => line.kind === "user")
          .map((line) => line.text)
          .join("\n"),
      };
    } finally {
      finishListenerTurn(runtime, lease, {
        stopReason: "end_turn",
        socket,
        agentId,
        conversationId,
      });
    }
  }

  try {
    await settingsManager.reset();
    await settingsManager.initialize();
    const skillInput = await prepare("/grill-me about this spec");
    expect(skillInput.sent).toContain("Ask hard questions.");
    expect(skillInput.sent).toContain("about this spec");
    expect(skillInput.display).toBe("/grill-me about this spec");
    const batchedInput = await prepare(["earlier question", "/grill-me later"]);
    expect(batchedInput.sent).toContain("Ask hard questions.");
    expect(batchedInput.display).toBe("earlier question\n/grill-me later");
    const builtInInput = await prepare("/doctor why is this broken");
    expect(builtInInput.sent).not.toContain("Wrong command.");
    expect(builtInInput.sent).toContain("/doctor why is this broken");
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    directory.cleanup();
  }
});
