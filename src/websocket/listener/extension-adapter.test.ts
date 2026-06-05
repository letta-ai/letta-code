import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
} from "@/backend/dev/pi-provider-extension-registry";
import {
  createListenerExtensionAdapter,
  createListenerExtensionContext,
  LISTENER_EXTENSION_CAPABILITIES,
} from "@/websocket/listener/extension-adapter";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-listener-extension-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  clearRegisteredPiProviders();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("listener extension adapter", () => {
  test("uses provider-only capabilities", () => {
    expect(LISTENER_EXTENSION_CAPABILITIES).toEqual({
      tools: false,
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

  test("builds a listener-scoped extension context", () => {
    const context = createListenerExtensionContext({
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

  test("loads provider registrations without exposing other listener capabilities", async () => {
    const root = createTempDir();
    const extensionsDir = join(root, "extensions");
    const cacheDir = join(root, "cache");
    const extensionPath = join(extensionsDir, "kilo.ts");
    mkdirSync(extensionsDir, { recursive: true });
    writeFileSync(
      extensionPath,
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
          name: "ignored_tool",
          description: "Should not register on listener",
          parameters: { type: "object", properties: {} },
          run() { return "ignored"; },
        });
        letta.events.on("conversation_open", () => undefined);
        letta.ui.openPanel({ id: "ignored-panel", content: "ignored" });
        letta.ui.setStatus("ignored-status", "ignored");
      }`,
    );

    const adapter = createListenerExtensionAdapter({
      cacheDirectory: cacheDir,
      globalExtensionsDirectory: extensionsDir,
      sessionId: "listen-provider-test",
      workingDirectory: root,
    });

    await adapter.reload();

    expect(getRegisteredPiProvider("kilo")?.config).toMatchObject({
      name: "Kilo",
      baseUrl: "https://api.kilo.test/v1",
      models: [{ id: "kilo-code", contextWindow: 128000 }],
    });

    const snapshot = adapter.getSnapshot().registry;
    expect(snapshot.capabilities).toEqual(LISTENER_EXTENSION_CAPABILITIES);
    expect(snapshot.loadedPaths).toEqual([extensionPath]);
    expect(snapshot.commands).toEqual({});
    expect(snapshot.tools).toEqual({});
    expect(snapshot.events).toEqual({});
    expect(snapshot.ui.panels).toEqual({});
    expect(snapshot.ui.statusValues).toEqual({});

    adapter.dispose();
    expect(getRegisteredPiProvider("kilo")).toBeUndefined();
  });
});
