import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearRegisteredPiProviders,
  listRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-extension-registry";
import { DISABLED_EXTENSION_CAPABILITIES } from "@/extensions/capabilities";
import { LETTA_DISABLE_EXTENSIONS_ENV } from "@/extensions/disable";
import { createDisabledExtensionAdapter } from "@/extensions/disabled-extension-adapter";
import { getExtensionDiagnosticsLatestFilePath } from "@/extensions/extension-diagnostics-file";
import {
  clearExtensionTools,
  getExtensionToolDefinition,
  registerExtensionTool,
} from "@/extensions/tool-registry";
import type { ExtensionContext } from "@/extensions/types";

function createExtensionContext(agentName = "Amelia"): ExtensionContext {
  return {
    agent: { id: "agent-1", name: agentName },
    cwd: "/tmp/project",
    sessionId: "conversation-1",
  } as ExtensionContext;
}

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-disabled-extensions-"));
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function registerTestExtensionTool(name: string): void {
  registerExtensionTool({
    activationSignal: new AbortController().signal,
    description: "Test tool",
    getContext: () => createExtensionContext(),
    isAvailable: () => true,
    name,
    owner: {
      generation: 0,
      id: `test:${name}`,
      path: `${name}.ts`,
      scope: "global",
    },
    parameters: { type: "object", properties: {} },
    parallelSafe: false,
    path: `${name}.ts`,
    requiresApproval: false,
    run: () => "test",
  });
}

function registerTestPiProvider(name: string): void {
  registerPiProvider(name, {
    api: "openai-completions",
    apiKey: "not-needed",
    baseUrl: "http://localhost:8000/v1",
    models: [
      {
        id: `${name}-model`,
        name: "Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
      },
    ],
  });
}

describe("disabled extension adapter", () => {
  test("clears extension registries and exposes no-op adapter surfaces", async () => {
    const originalDisableEnv = process.env[LETTA_DISABLE_EXTENSIONS_ENV];
    const diagnosticsRoot = createTempDir();

    try {
      delete process.env[LETTA_DISABLE_EXTENSIONS_ENV];
      registerTestExtensionTool("stale_extension_tool");
      registerTestPiProvider("stale-provider");

      expect(getExtensionToolDefinition("stale_extension_tool")).toBeDefined();
      expect(listRegisteredPiProviders()).toHaveLength(1);

      const adapter = createDisabledExtensionAdapter({
        diagnosticsRootDirectory: diagnosticsRoot,
        initialContext: createExtensionContext(),
      });

      expect(adapter.getSnapshot()).toMatchObject({
        hadStatuslineRenderer: false,
        hasExtensionSources: false,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
        DISABLED_EXTENSION_CAPABILITIES,
      );
      expect(adapter.getSnapshot().registry.sources).toEqual([]);
      expect(adapter.getSnapshot().registry.loadedPaths).toEqual([]);
      expect(adapter.getSnapshot().registry.commands).toEqual({});
      expect(adapter.getSnapshot().registry.tools).toEqual({});
      expect(adapter.getSnapshot().registry.ui.panels).toEqual({});
      expect(adapter.getSnapshot().registry.ui.statuslineRenderer).toBeNull();
      expect(adapter.getBackend()).toBeUndefined();
      expect(
        getExtensionToolDefinition("stale_extension_tool"),
      ).toBeUndefined();
      expect(listRegisteredPiProviders()).toEqual([]);

      let notifications = 0;
      const unsubscribe = adapter.subscribe(() => {
        notifications += 1;
      });
      await adapter.reload();
      unsubscribe();
      expect(notifications).toBe(0);
      expect(
        readJsonFile(getExtensionDiagnosticsLatestFilePath(diagnosticsRoot)),
      ).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      const result = await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });
      expect(result.handlerCount).toBe(0);
      expect(result.results).toEqual([]);

      adapter.updateContext(createExtensionContext("Updated Agent"));
      expect(adapter.getContext().agent.name).toBe("Updated Agent");

      adapter.dispose();
    } finally {
      rmSync(diagnosticsRoot, { force: true, recursive: true });
      clearExtensionTools();
      clearRegisteredPiProviders();
      if (originalDisableEnv === undefined) {
        delete process.env[LETTA_DISABLE_EXTENSIONS_ENV];
      } else {
        process.env[LETTA_DISABLE_EXTENSIONS_ENV] = originalDisableEnv;
      }
    }
  });
});
