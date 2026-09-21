import { expect, test } from "bun:test";
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
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import {
  type ConversationTagBackend,
  createGitHubPullRequestOutputTracker,
} from "@/tools/impl/github-pull-request-tracker";
import {
  clearCapturedToolExecutionContexts,
  getExecutionContextById,
} from "@/tools/manager";
import { GITHUB_PR_CONVERSATIONS_ENV } from "@/utils/subagent-launch-marker";
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

test("reused listener turns do not inherit process-level PR attribution", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  const originalAttribution = process.env[GITHUB_PR_CONVERSATIONS_ENV];
  await settingsManager.reset();
  const restoreEnv = isolateAmbientLettaTestEnv();
  process.env.HOME = directory.path;
  process.env[GITHUB_PR_CONVERSATIONS_ENV] = "conv-old-launcher";
  const listener = createRuntime();
  const agentId = "agent-turn-attribution";
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  __testSetBackend(new FakeHeadlessBackend(agentId));
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
  const tagsByConversation = new Map<string, string[]>();
  const tagBackend: ConversationTagBackend = {
    updateConversation: async (id, body) => {
      const tags = [
        ...new Set([
          ...(tagsByConversation.get(id) ?? []),
          ...(body.tags_to_add ?? []),
        ]),
      ];
      tagsByConversation.set(id, tags);
      return { id, tags };
    },
  };

  async function recordTurn(
    conversationId: string,
    pr: number,
    githubPullRequestConversationIds?: string[],
  ) {
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
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
          messages: [{ role: "user", content: "open a pull request" }],
          clientToolset: { base: "default" },
          githubPullRequestConversationIds,
        },
        runtime,
        agentId,
        conversationId,
        workingDirectory: directory.path,
        permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
        turnLease: lease,
      });
      if (result.kind !== "ready") throw new Error("Turn setup was not ready");
      const context = getExecutionContextById(
        result.preparedToolContext.preparedToolContext.contextId,
      );
      if (!context) throw new Error("Tool context was not captured");
      const tracker = runWithRuntimeContext(context.runtimeContext, () =>
        createGitHubPullRequestOutputTracker("gh pr create --fill", {
          backend: tagBackend,
        }),
      );
      tracker?.append(
        `https://github.com/letta-ai/letta-code/pull/${pr}\n`,
        "stdout",
      );
      await tracker?.finish();
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
    await settingsManager.initialize();
    await recordTurn("default", 4002, ["conv-launcher"]);
    await recordTurn("default", 4003);
    await recordTurn("conv-worker", 4004);
    expect([...tagsByConversation]).toEqual([
      ["conv-launcher", ["github:pull-request:letta-ai:letta-code:4002"]],
      ["conv-worker", ["github:pull-request:letta-ai:letta-code:4004"]],
    ]);

    // Direct headless workers still use their launch environment.
    const direct = runWithRuntimeContext({ conversationId: "default" }, () =>
      createGitHubPullRequestOutputTracker("gh pr create --fill", {
        backend: tagBackend,
      }),
    );
    direct?.append(
      "https://github.com/letta-ai/letta-code/pull/4005\n",
      "stdout",
    );
    await direct?.finish();
    expect(tagsByConversation.get("conv-old-launcher")).toEqual([
      "github:pull-request:letta-ai:letta-code:4005",
    ]);
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
    if (originalAttribution === undefined)
      delete process.env[GITHUB_PR_CONVERSATIONS_ENV];
    else process.env[GITHUB_PR_CONVERSATIONS_ENV] = originalAttribution;
    directory.cleanup();
  }
});
