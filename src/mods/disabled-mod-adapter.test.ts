import { describe, expect, test } from "bun:test";
import {
  clearRegisteredPiProviders,
  listRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { DISABLED_MOD_CAPABILITIES } from "@/mods/capabilities";
import { LETTA_DISABLE_MODS_ENV } from "@/mods/disable";
import { createDisabledModAdapter } from "@/mods/disabled-mod-adapter";
import {
  clearModPermissions,
  getModPermissionDefinition,
  registerModPermission,
} from "@/mods/permission-registry";
import {
  clearModTools,
  getModToolDefinition,
  registerModTool,
} from "@/mods/tool-registry";
import type { ModContext } from "@/mods/types";

function createModContext(agentName = "Amelia"): ModContext {
  return {
    agent: { id: "agent-1", name: agentName },
    cwd: "/tmp/project",
    sessionId: "conversation-1",
  } as ModContext;
}

function registerTestModTool(name: string): void {
  registerModTool({
    activationSignal: new AbortController().signal,
    description: "Test tool",
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
    approvalPolicy: "auto",
    requiresApproval: false,
    run: () => "test",
  });
}

function registerTestModPermission(id: string): void {
  registerModPermission({
    activationSignal: new AbortController().signal,
    check: () => undefined,
    id,
    owner: {
      generation: 0,
      id: `test:${id}`,
      path: `${id}.ts`,
      scope: "global",
    },
    path: `${id}.ts`,
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

describe("disabled mod adapter", () => {
  test("clears mod registries and exposes no-op adapter surfaces", async () => {
    const originalDisableEnv = process.env[LETTA_DISABLE_MODS_ENV];

    try {
      delete process.env[LETTA_DISABLE_MODS_ENV];
      registerTestModPermission("stale-permission");
      registerTestModTool("stale_mod_tool");
      registerTestPiProvider("stale-provider");

      expect(getModPermissionDefinition("stale-permission")).toBeDefined();
      expect(getModToolDefinition("stale_mod_tool")).toBeDefined();
      expect(listRegisteredPiProviders()).toHaveLength(1);

      const adapter = createDisabledModAdapter();

      expect(adapter.getSnapshot()).toMatchObject({
        hadModPanels: false,
        hasModSources: false,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
        DISABLED_MOD_CAPABILITIES,
      );
      expect(adapter.getSnapshot().registry.sources).toEqual([]);
      expect(adapter.getSnapshot().registry.loadedPaths).toEqual([]);
      expect(adapter.getSnapshot().registry.commands).toEqual({});
      expect(adapter.getSnapshot().registry.permissions).toEqual({});
      expect(adapter.getSnapshot().registry.tools).toEqual({});
      expect(adapter.getSnapshot().registry.ui.panels).toEqual({});
      expect(adapter.getBackend()).toBeUndefined();
      expect(getModPermissionDefinition("stale-permission")).toBeUndefined();
      expect(getModToolDefinition("stale_mod_tool")).toBeUndefined();
      expect(listRegisteredPiProviders()).toEqual([]);

      let notifications = 0;
      const unsubscribe = adapter.subscribe(() => {
        notifications += 1;
      });
      await adapter.reload();
      unsubscribe();
      expect(notifications).toBe(0);

      const result = await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );
      expect(result.handlerCount).toBe(0);
      expect(result.results).toEqual([]);

      adapter.dispose();
    } finally {
      clearModPermissions();
      clearModTools();
      clearRegisteredPiProviders();
      if (originalDisableEnv === undefined) {
        delete process.env[LETTA_DISABLE_MODS_ENV];
      } else {
        process.env[LETTA_DISABLE_MODS_ENV] = originalDisableEnv;
      }
    }
  });
});
