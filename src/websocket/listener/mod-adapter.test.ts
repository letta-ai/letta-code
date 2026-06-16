import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";
import {
  createListenerModAdapter,
  createListenerModContext,
  LISTENER_MOD_CAPABILITIES,
} from "@/websocket/listener/mod-adapter";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-listener-mod-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  clearModTools();
  clearRegisteredPiProviders();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("listener mod adapter", () => {
  test("uses provider and tool capabilities", () => {
    expect(LISTENER_MOD_CAPABILITIES).toEqual({
      tools: true,
      commands: false,
      events: {
        lifecycle: false,
        tools: false,
        turns: false,
      },
      permissions: false,
      providers: true,
      ui: {
        panels: false,
        statusValues: false,
        customStatuslineRenderer: false,
      },
    });
  });

  test("builds a listener-scoped mod context", () => {
    const context = createListenerModContext({
      sessionId: "listen-test-session",
      workingDirectory: "/tmp/listener-workspace",
    });

    expect(context.sessionId).toBe("listen-test-session");
    expect(context.cwd).toBe("/tmp/listener-workspace");
    expect(context.workspace).toEqual({
      cwd: "/tmp/listener-workspace",
      currentDir: "/tmp/listener-workspace",
      projectDir: "/tmp/listener-workspace",
    });
    expect(context.agent).toEqual({ id: null, name: null });
    expect(context.model).toEqual({
      id: null,
      displayName: null,
      provider: null,
      reasoningEffort: null,
    });
    expect(context.memfs).toEqual({ enabled: false, memoryDir: null });
  });

  test("builds listener context with active scope metadata", () => {
    const context = createListenerModContext({
      sessionId: "listen-test-session",
      workingDirectory: "/tmp/listener-workspace",
      permissionMode: "standard",
      toolset: "default",
      agent: {
        id: "agent-123",
        name: "Desktop Agent",
        model: "anthropic/claude-sonnet-4-6",
        llm_config: {
          model: "claude-sonnet-4-6",
          model_endpoint_type: "anthropic",
          reasoning_effort: "medium",
        },
      },
    });

    expect(context.agent).toEqual({ id: "agent-123", name: "Desktop Agent" });
    expect(context.model).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      reasoningEffort: "medium",
    });
    expect(context.permissionMode).toBe("standard");
    expect(context.toolset).toBe("default");
  });

  test("loads provider and tool registrations without exposing other listener capabilities", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    const modPath = join(modsDir, "kilo.ts");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      modPath,
      `export default function activate(letta) {
        letta.providers.register("kilo", {
          name: "Kilo",
          description: "Connect Kilo",
          api: "openai-completions",
          baseUrl: "https://api.kilo.test/v1",
          apiKey: "KILO_API_KEY",
          models: [{
            id: "kilo-code",
            name: "Kilo Code",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        });
        letta.commands.register({
          id: "ignored-command",
          description: "Should not register on listener",
          run() { return { type: "handled" }; },
        });
        letta.tools.register({
          name: "listener_tool",
          description: "Should register on listener",
          parameters: { type: "object", properties: {} },
          run(ctx) { return "agent:" + ctx.agent.id; },
        });
        letta.events.on("conversation_open", () => undefined);
        letta.ui.openPanel({ id: "ignored-panel", content: "ignored" });
        letta.ui.setStatus("ignored-status", "ignored");
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "listen-provider-test",
      workingDirectory: root,
    });

    await adapter.reload();

    expect(getRegisteredPiProvider("kilo")?.config).toMatchObject({
      name: "Kilo",
      baseUrl: "https://api.kilo.test/v1",
      models: [{ id: "kilo-code", contextWindow: 128000 }],
    });
    expect(getModToolDefinition("listener_tool")).toMatchObject({
      name: "listener_tool",
      description: "Should register on listener",
      path: modPath,
    });

    const snapshot = adapter.getSnapshot().registry;
    expect(snapshot.capabilities).toEqual(LISTENER_MOD_CAPABILITIES);
    expect(snapshot.loadedPaths).toEqual([modPath]);
    expect(snapshot.commands).toEqual({});
    expect(snapshot.tools.listener_tool).toMatchObject({
      name: "listener_tool",
      description: "Should register on listener",
      path: modPath,
    });
    expect(snapshot.events).toEqual({});
    expect(snapshot.ui.panels).toEqual({});
    expect(snapshot.ui.statusValues).toEqual({});

    adapter.dispose();
    expect(getRegisteredPiProvider("kilo")).toBeUndefined();
    expect(getModToolDefinition("listener_tool")).toBeUndefined();
  });
});
