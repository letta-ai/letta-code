import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import type { Backend } from "@/backend";
import { DISABLED_EXTENSION_CAPABILITIES } from "@/extensions/capabilities";
import { LETTA_DISABLE_EXTENSIONS_ENV } from "@/extensions/disable";
import { createExtensionAdapter } from "@/extensions/extension-adapter";
import { getExtensionDiagnosticsLatestFilePath } from "@/extensions/extension-diagnostics-file";
import type { ExtensionContext } from "@/extensions/types";

type ExtensionAdapterTestGlobal = typeof globalThis & {
  __lettaAdapterEvents?: string[];
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extension-adapter-"));
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

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("extension adapter", () => {
  test("LETTA_DISABLE_EXTENSIONS disables the adapter", () => {
    const original = process.env[LETTA_DISABLE_EXTENSIONS_ENV];
    try {
      process.env[LETTA_DISABLE_EXTENSIONS_ENV] = "1";
      const adapter = createExtensionAdapter({
        getClient: async () => ({}) as unknown as Letta,
        initialContext: createExtensionContext(),
      });

      expect(adapter.getSnapshot()).toMatchObject({
        hasExtensionSources: false,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
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

  test("disabled option disables extensions for the process", () => {
    const original = process.env[LETTA_DISABLE_EXTENSIONS_ENV];
    try {
      delete process.env[LETTA_DISABLE_EXTENSIONS_ENV];
      const adapter = createExtensionAdapter({
        disabled: true,
        getClient: async () => ({}) as unknown as Letta,
        initialContext: createExtensionContext(),
      });

      expect(process.env[LETTA_DISABLE_EXTENSIONS_ENV]).toBe("1");
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
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

  test("reload writes latest diagnostics and clears stale failures", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      const extensionPath = path.join(extensionDir, "diagnostic.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function() {
          throw new Error("activation failed");
        }`,
      );

      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();

      const diagnosticsPath =
        getExtensionDiagnosticsLatestFilePath(diagnosticsRoot);
      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: {
          diagnostics: [
            {
              extension: expect.objectContaining({ path: extensionPath }),
              message: "activation failed",
              phase: "activate",
              severity: "error",
            },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      });

      writeFileSync(extensionPath, "export default function() {}");
      await adapter.reload();

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload does not create diagnostics files when no extensions exist", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();

      expect(
        existsSync(getExtensionDiagnosticsLatestFilePath(diagnosticsRoot)),
      ).toBe(false);

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runtime diagnostics writes are coalesced", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            throw new Error("runtime failed");
          });
        }`,
      );

      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 5,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();
      const diagnosticsPath =
        getExtensionDiagnosticsLatestFilePath(diagnosticsRoot);
      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });
      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "resume",
      });

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      await sleep(20);

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: {
          diagnostics: [
            { message: "runtime failed", phase: "event", severity: "error" },
            { message: "runtime failed", phase: "event", severity: "error" },
          ],
          errorCount: 2,
          warningCount: 0,
        },
      });

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runtime diagnostics writes are not starved by continuous diagnostics", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", (event) => {
            throw new Error("runtime failed " + event.reason);
          });
        }`,
      );

      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 20,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();
      const diagnosticsPath =
        getExtensionDiagnosticsLatestFilePath(diagnosticsRoot);

      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });
      await sleep(10);
      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "resume",
      });

      await sleep(15);

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: {
          diagnostics: [
            {
              message: "runtime failed startup",
              phase: "event",
              severity: "error",
            },
            {
              message: "runtime failed resume",
              phase: "event",
              severity: "error",
            },
          ],
          errorCount: 2,
          warningCount: 0,
        },
      });

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("dispose flushes pending runtime diagnostics writes", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            throw new Error("runtime failed");
          });
        }`,
      );

      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 30_000,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();
      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });

      const diagnosticsPath =
        getExtensionDiagnosticsLatestFilePath(diagnosticsRoot);
      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      adapter.dispose();

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: {
          diagnostics: [
            { message: "runtime failed", phase: "event", severity: "error" },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runtime diagnostic reports are written", async () => {
    const root = createTempDir();

    try {
      const extensionDir = path.join(root, "global-extensions");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            letta.diagnostics.report({ message: "missing optional env" });
          });
        }`,
      );

      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 5,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      await adapter.reload();
      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });
      await sleep(20);

      expect(
        readJsonFile(getExtensionDiagnosticsLatestFilePath(diagnosticsRoot)),
      ).toMatchObject({
        report: {
          diagnostics: [
            {
              errorName: "ExtensionDiagnosticReport",
              message: "missing optional env",
              phase: "report",
              severity: "error",
            },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      });

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads extensions and dispatches events with fresh context and backend", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionAdapterTestGlobal;
    testGlobal.__lettaAdapterEvents = [];

    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", async (event, ctx) => {
            const fork = await ctx.conversation.fork({ hidden: true });
            globalThis.__lettaAdapterEvents.push(
              event.reason + ":" + ctx.context.agent.name + ":" + fork.id,
            );
          });
        }`,
      );

      const backend = {
        forkConversation: async () => ({ id: "forked-conversation" }),
      } as unknown as Backend;
      const adapter = createExtensionAdapter({
        cacheDirectory: path.join(root, "extension-cache"),
        getBackend: () => backend,
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
        initialContext: createExtensionContext(),
      });

      expect(adapter.getSnapshot()).toMatchObject({
        hasExtensionSources: true,
        isLoading: true,
      });
      expect(adapter.getSnapshot()).toBe(adapter.getSnapshot());

      const loadingResult = await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });
      expect(loadingResult.handlerCount).toBe(0);
      expect(testGlobal.__lettaAdapterEvents).toEqual([]);

      await adapter.reload();
      adapter.updateContext(createExtensionContext("Updated Agent"));

      expect(adapter.getSnapshot()).toMatchObject({
        hasExtensionSources: true,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.loadedPaths).toHaveLength(1);

      await adapter.events.emit("conversation_open", {
        agentId: "agent-1",
        agentName: "Updated Agent",
        conversationId: "conversation-1",
        reason: "startup",
      });

      expect(testGlobal.__lettaAdapterEvents).toEqual([
        "startup:Updated Agent:forked-conversation",
      ]);

      adapter.dispose();
    } finally {
      delete testGlobal.__lettaAdapterEvents;
      rmSync(root, { force: true, recursive: true });
    }
  });
});
