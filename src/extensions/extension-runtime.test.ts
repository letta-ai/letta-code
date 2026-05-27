import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { createExtensionRuntime } from "@/extensions/extension-runtime";
import type {
  ExtensionContext,
  ExtensionRuntimeBackendApi,
} from "@/extensions/types";

type ExtensionRuntimeTestGlobal = typeof globalThis & {
  __lettaRuntimeEvents?: string[];
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extension-runtime-"));
}

function createExtensionContext(agentName = "Amelia"): ExtensionContext {
  return {
    app: { version: "test" },
    backgroundAgents: [],
    contextWindow: {
      currentUsage: null,
      remainingPercentage: null,
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
    },
    cost: {
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalDurationMs: 0,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    cwd: "/tmp/project",
    lastRunId: null,
    memfs: { enabled: false, memoryDir: null },
    model: {
      displayName: "Sonnet",
      id: "model-1",
      provider: "anthropic",
      reasoningEffort: null,
    },
    networkPhase: null,
    permissionMode: "standard",
    reflection: { mode: null, stepCount: 0 },
    sessionId: "conversation-1",
    systemPromptId: null,
    terminalWidth: 80,
    toolset: "default",
    agent: { id: "agent-1", name: agentName },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
  };
}

describe("extension runtime", () => {
  test("loads extensions and dispatches events with fresh context and backend", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionRuntimeTestGlobal;
    testGlobal.__lettaRuntimeEvents = [];

    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", async (event, ctx) => {
            const fork = await ctx.conversation.fork({ hidden: true });
            globalThis.__lettaRuntimeEvents.push(
              event.reason + ":" + ctx.context.agent.name + ":" + fork.id,
            );
          });
        }`,
      );

      const backend: ExtensionRuntimeBackendApi = {
        forkConversation: async () => ({ id: "forked-conversation" }),
        getConversationHistory: async () => [],
        sendMessageStream: async () => (async function* () {})(),
      };
      const runtime = createExtensionRuntime({
        cacheDirectory: path.join(root, "extension-cache"),
        getBackendApi: () => backend,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      expect(runtime.getSnapshot()).toMatchObject({
        hasExtensionSources: true,
        isLoading: true,
      });
      expect(runtime.getSnapshot()).toBe(runtime.getSnapshot());

      await runtime.reload();
      runtime.updateContext(createExtensionContext("Updated Agent"));

      expect(runtime.getSnapshot()).toMatchObject({
        hasExtensionSources: true,
        isLoading: false,
      });
      expect(runtime.getSnapshot().registry.loadedPaths).toHaveLength(1);

      await runtime.emitEvent("conversation_open", {
        agentId: "agent-1",
        agentName: "Updated Agent",
        conversationId: "conversation-1",
        reason: "startup",
      });

      expect(testGlobal.__lettaRuntimeEvents).toEqual([
        "startup:Updated Agent:forked-conversation",
      ]);

      runtime.dispose();
    } finally {
      delete testGlobal.__lettaRuntimeEvents;
      rmSync(root, { force: true, recursive: true });
    }
  });
});
