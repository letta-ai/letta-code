import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { setActiveRuntime } from "./runtime";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import { __listenerWarmupTestUtils } from "./warmup";

const ORIGINAL_MODEL = "openai/gpt-5.4";
const SWITCHED_MODEL = "anthropic/claude-sonnet-4-6";

afterEach(() => {
  __listenerWarmupTestUtils.resetWarmupDepsForTests();
  __listenerModAdapterTestUtils.resetForTests();
  clearCapturedToolExecutionContexts();
  setActiveRuntime(null);
  setCurrentAgentId(null);
  setCurrentAgentName(null);
  setConversationId(null);
  __testSetBackend(null);
});

async function prepareTurnWithMod(modSource: string) {
  const directory = await mkdtemp(join(tmpdir(), "turn-setup-model-refresh-"));
  const cacheDirectory = await mkdtemp(
    join(tmpdir(), "turn-setup-model-refresh-cache-"),
  );
  const originalHome = process.env.HOME;
  process.env.HOME = directory;
  await settingsManager.reset();
  await settingsManager.initialize();

  const agentId = "agent-turn-setup-model-refresh";
  const listener = createRuntime();
  const backend = new FakeHeadlessBackend(
    agentId,
    undefined,
    {},
    { modelHandle: ORIGINAL_MODEL },
  );
  __testSetBackend(backend);
  const conversation = await backend.createConversation({
    agent_id: agentId,
    model: ORIGINAL_MODEL,
  } as never);
  const conversationId = conversation.id;
  const modelBefore = (await backend.retrieveConversation(conversationId))
    .model;

  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => false,
  );
  await writeFile(join(directory, "refresh-model.ts"), modSource);
  listener.modAdapter = createListenerModAdapter({
    cacheDirectory,
    globalModsDirectory: directory,
    sessionId: conversationId,
    workingDirectory: directory,
  });
  await listener.modAdapter.reload();
  setActiveRuntime(listener);

  const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
  runtime.skillSources = [];
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: directory,
  });
  try {
    const result = await prepareListenerTurn({
      msg: {
        type: "message",
        agentId,
        conversationId,
        messages: [{ role: "user", content: "hello" }],
        clientToolset: { base: "default" },
      },
      runtime,
      agentId,
      conversationId,
      workingDirectory: directory,
      permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
      turnLease: lease,
    });
    const conversationAfter =
      await backend.retrieveConversation(conversationId);
    return {
      result,
      modelBefore,
      modelAfter: conversationAfter.model,
      modelSettingsAfter: conversationAfter.model_settings,
    };
  } finally {
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      agentId,
      conversationId,
    });
    disposeListenerModAdapter(listener);
    await settingsManager.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

test("turn_start does not override the model when the handler leaves it unchanged", async () => {
  const { result, modelBefore } = await prepareTurnWithMod(
    `export default function activate(letta) {
      letta.events.on("turn_start", () => {});
    }`,
  );

  expect(modelBefore).toBe(ORIGINAL_MODEL);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.overrideModel).toBeUndefined();
});

test("turn_start still overrides the model when a handler switches it", async () => {
  const { result, modelBefore, modelAfter } = await prepareTurnWithMod(
    `export default function activate(letta) {
      letta.events.on("turn_start", async (_event, ctx) => {
        await ctx.conversation.updateLlmConfig({
          model: ${JSON.stringify(SWITCHED_MODEL)},
          scope: "conversation",
        });
      });
    }`,
  );

  expect(modelBefore).toBe(ORIGINAL_MODEL);
  expect(modelAfter).toBe(SWITCHED_MODEL);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.overrideModel).toBe(SWITCHED_MODEL);
});

test("turn_start does not override the model when a handler changes only reasoning effort", async () => {
  const { result, modelAfter, modelSettingsAfter } = await prepareTurnWithMod(
    `export default function activate(letta) {
      letta.events.on("turn_start", async (_event, ctx) => {
        await ctx.conversation.updateLlmConfig({ reasoningEffort: "high" });
      });
    }`,
  );

  // The handler did persist new settings, so the override is omitted because
  // the model is unchanged, not because the handler never ran.
  expect(modelAfter).toBe(ORIGINAL_MODEL);
  expect(modelSettingsAfter).toMatchObject({
    reasoning: { reasoning_effort: "high" },
  });
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.overrideModel).toBeUndefined();
});

test("turn_start ignores a model switch on a forked conversation", async () => {
  const { result, modelAfter } = await prepareTurnWithMod(
    `export default function activate(letta) {
      letta.events.on("turn_start", async (_event, ctx) => {
        const fork = await ctx.conversation.fork();
        await fork.updateLlmConfig({ model: ${JSON.stringify(SWITCHED_MODEL)} });
      });
    }`,
  );

  expect(modelAfter).toBe(ORIGINAL_MODEL);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.overrideModel).toBeUndefined();
});
