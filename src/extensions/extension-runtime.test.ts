import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import {
  clearRegisteredPiProviders,
  listRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-extension-registry";
import { DISABLED_EXTENSION_CAPABILITIES } from "@/extensions/capabilities";
import { LETTA_DISABLE_EXTENSIONS_ENV } from "@/extensions/disable";
import { createExtensionRuntime } from "@/extensions/extension-runtime";
import {
  clearExtensionTools,
  getExtensionToolDefinition,
  registerExtensionTool,
} from "@/extensions/tool-registry";
import type {
  ExtensionContext,
  ExtensionRuntimeBackendApi,
} from "@/extensions/types";

type ExtensionRuntimeTestGlobal = typeof globalThis & {
  __lettaRuntimeEvents?: string[];
  __lettaDisabledExtensionLoaded?: boolean;
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
  test("LETTA_DISABLE_EXTENSIONS disables the runtime", () => {
    const original = process.env[LETTA_DISABLE_EXTENSIONS_ENV];
    try {
      process.env[LETTA_DISABLE_EXTENSIONS_ENV] = "1";
      const runtime = createExtensionRuntime({
        getClient: async () => ({}) as unknown as Letta,
        initialContext: createExtensionContext(),
      });

      expect(runtime.getSnapshot()).toMatchObject({
        hasExtensionSources: false,
        isLoading: false,
      });
      expect(runtime.getSnapshot().registry.capabilities).toEqual(
        DISABLED_EXTENSION_CAPABILITIES,
      );
    } finally {
      if (original === undefined) {
        delete process.env[LETTA_DISABLE_EXTENSIONS_ENV];
      } else {
        process.env[LETTA_DISABLE_EXTENSIONS_ENV] = original;
      }
    }
  });

  test("disabled runtime does not load extensions or expose extension capabilities", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionRuntimeTestGlobal;
    const originalDisableEnv = process.env[LETTA_DISABLE_EXTENSIONS_ENV];

    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "disabled.ts"),
        `export default function(letta) {
          globalThis.__lettaDisabledExtensionLoaded = true;
          letta.tools.register({
            name: "disabled_tool",
            description: "Should not load",
            parameters: { type: "object", properties: {} },
            run() { return "loaded"; },
          });
          letta.providers.register("disabled-provider", {
            api: "openai-completions",
            baseUrl: "http://localhost:8000/v1",
            apiKey: "not-needed",
            models: [{
              id: "disabled-model",
              name: "Disabled Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 1000,
            }],
          });
        }`,
      );
      registerExtensionTool({
        activationSignal: new AbortController().signal,
        description: "Stale tool",
        getContext: () => createExtensionContext(),
        isAvailable: () => true,
        name: "stale_extension_tool",
        owner: {
          generation: 0,
          id: "test:stale",
          path: "stale.ts",
          scope: "global",
        },
        parameters: { type: "object", properties: {} },
        parallelSafe: false,
        path: "stale.ts",
        requiresApproval: false,
        run: () => "stale",
      });
      registerPiProvider("stale-provider", {
        api: "openai-completions",
        apiKey: "not-needed",
        baseUrl: "http://localhost:8000/v1",
        models: [
          {
            id: "stale-model",
            name: "Stale Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 1000,
          },
        ],
      });

      const runtime = createExtensionRuntime({
        cacheDirectory: path.join(root, "extension-cache"),
        disabled: true,
        getClient: async () => {
          throw new Error(
            "client should not initialize when extensions are disabled",
          );
        },
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });
      registerExtensionTool({
        activationSignal: new AbortController().signal,
        description: "Post-disable tool",
        getContext: () => createExtensionContext(),
        isAvailable: () => true,
        name: "post_disabled_extension_tool",
        owner: {
          generation: 0,
          id: "test:post-disabled",
          path: "post-disabled.ts",
          scope: "global",
        },
        parameters: { type: "object", properties: {} },
        parallelSafe: false,
        path: "post-disabled.ts",
        requiresApproval: false,
        run: () => "post-disabled",
      });

      expect(runtime.getSnapshot()).toMatchObject({
        hadStatuslineRenderer: false,
        hasExtensionSources: false,
        isLoading: false,
      });
      expect(runtime.getSnapshot().registry.capabilities).toEqual(
        DISABLED_EXTENSION_CAPABILITIES,
      );
      expect(runtime.getSnapshot().registry.sources).toEqual([]);

      await runtime.reload();
      const result = await runtime.emitEvent("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });

      expect(result.handlerCount).toBe(0);
      expect(testGlobal.__lettaDisabledExtensionLoaded).toBeUndefined();
      expect(runtime.getSnapshot().registry.loadedPaths).toEqual([]);
      expect(runtime.getSnapshot().registry.commands).toEqual({});
      expect(runtime.getSnapshot().registry.tools).toEqual({});
      expect(runtime.getSnapshot().registry.ui.panels).toEqual({});
      expect(runtime.getSnapshot().registry.ui.statuslineRenderer).toBeNull();
      expect(
        getExtensionToolDefinition("stale_extension_tool"),
      ).toBeUndefined();
      expect(
        getExtensionToolDefinition("post_disabled_extension_tool"),
      ).toBeUndefined();
      expect(process.env[LETTA_DISABLE_EXTENSIONS_ENV]).toBe("1");
      expect(listRegisteredPiProviders()).toEqual([]);
    } finally {
      delete testGlobal.__lettaDisabledExtensionLoaded;
      clearExtensionTools();
      clearRegisteredPiProviders();
      if (originalDisableEnv === undefined) {
        delete process.env[LETTA_DISABLE_EXTENSIONS_ENV];
      } else {
        process.env[LETTA_DISABLE_EXTENSIONS_ENV] = originalDisableEnv;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

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
