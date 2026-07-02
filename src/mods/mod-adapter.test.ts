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
import { DISABLED_MOD_CAPABILITIES } from "@/mods/capabilities";
import { LETTA_DISABLE_MODS_ENV } from "@/mods/disable";
import { createModAdapter } from "@/mods/mod-adapter";
import { getModDiagnosticsLatestFilePath } from "@/mods/mod-diagnostics-file";
import type { ModContext } from "@/mods/types";

type ModAdapterTestGlobal = typeof globalThis & {
  __lettaAdapterEvents?: string[];
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-adapter-"));
}

function createModContext(agentName = "Amelia"): ModContext {
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

describe("mod adapter", () => {
  test("LETTA_DISABLE_MODS disables the adapter", () => {
    const original = process.env[LETTA_DISABLE_MODS_ENV];
    try {
      process.env[LETTA_DISABLE_MODS_ENV] = "1";
      const adapter = createModAdapter({
        getClient: async () => ({}) as unknown as Letta,
      });

      expect(adapter.getSnapshot()).toMatchObject({
        hasModSources: false,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
        DISABLED_MOD_CAPABILITIES,
      );
    } finally {
      if (original === undefined) {
        delete process.env[LETTA_DISABLE_MODS_ENV];
      } else {
        process.env[LETTA_DISABLE_MODS_ENV] = original;
      }
    }
  });

  test("disabled option disables mods for the process", () => {
    const original = process.env[LETTA_DISABLE_MODS_ENV];
    try {
      delete process.env[LETTA_DISABLE_MODS_ENV];
      const adapter = createModAdapter({
        disabled: true,
        getClient: async () => ({}) as unknown as Letta,
      });

      expect(process.env[LETTA_DISABLE_MODS_ENV]).toBe("1");
      expect(adapter.getSnapshot().registry.capabilities).toEqual(
        DISABLED_MOD_CAPABILITIES,
      );
    } finally {
      if (original === undefined) {
        delete process.env[LETTA_DISABLE_MODS_ENV];
      } else {
        process.env[LETTA_DISABLE_MODS_ENV] = original;
      }
    }
  });

  test("reload writes latest diagnostics and clears stale failures", async () => {
    const root = createTempDir();

    try {
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      const modPath = path.join(modDir, "diagnostic.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function() {
          throw new Error("activation failed");
        }`,
      );

      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();

      const diagnosticsPath = getModDiagnosticsLatestFilePath(diagnosticsRoot);
      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: {
          diagnostics: [
            {
              mod: expect.objectContaining({ path: modPath }),
              message: "activation failed",
              phase: "activate",
              severity: "error",
            },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      });

      writeFileSync(modPath, "export default function() {}");
      await adapter.reload();

      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload does not create diagnostics files when no mods exist", async () => {
    const root = createTempDir();

    try {
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();

      expect(existsSync(getModDiagnosticsLatestFilePath(diagnosticsRoot))).toBe(
        false,
      );

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runtime diagnostics writes are coalesced", async () => {
    const root = createTempDir();

    try {
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            throw new Error("runtime failed");
          });
        }`,
      );

      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 5,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      const diagnosticsPath = getModDiagnosticsLatestFilePath(diagnosticsRoot);
      expect(readJsonFile(diagnosticsPath)).toMatchObject({
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });

      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );
      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "resume",
        },
        createModContext(),
      );

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
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", (event) => {
            throw new Error("runtime failed " + event.reason);
          });
        }`,
      );

      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 20,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      const diagnosticsPath = getModDiagnosticsLatestFilePath(diagnosticsRoot);

      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );
      await sleep(10);
      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "resume",
        },
        createModContext(),
      );

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
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            throw new Error("runtime failed");
          });
        }`,
      );

      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 30_000,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );

      const diagnosticsPath = getModDiagnosticsLatestFilePath(diagnosticsRoot);
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
      const modDir = path.join(root, "global-mods");
      const diagnosticsRoot = path.join(root, "diagnostics");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", () => {
            letta.diagnostics.report({ message: "missing optional env" });
          });
        }`,
      );

      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        diagnosticsRootDirectory: diagnosticsRoot,
        diagnosticsWriteDelayMs: 5,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );
      await sleep(20);

      expect(
        readJsonFile(getModDiagnosticsLatestFilePath(diagnosticsRoot)),
      ).toMatchObject({
        report: {
          diagnostics: [
            {
              errorName: "ModDiagnosticReport",
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

  test("loads mods and dispatches events with fresh context and backend", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModAdapterTestGlobal;
    testGlobal.__lettaAdapterEvents = [];

    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", async (event, ctx) => {
            const fork = await ctx.conversation.fork({ hidden: true });
            globalThis.__lettaAdapterEvents.push(
              event.reason + ":" + ctx.agent.name + ":" + fork.id,
            );
          });
        }`,
      );

      const backend = {
        forkConversation: async () => ({ id: "forked-conversation" }),
      } as unknown as Backend;
      const adapter = createModAdapter({
        cacheDirectory: path.join(root, "mod-cache"),
        getBackend: () => backend,
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });

      expect(adapter.getSnapshot()).toMatchObject({
        hasModSources: true,
        isLoading: true,
      });
      expect(adapter.getSnapshot()).toBe(adapter.getSnapshot());

      const loadingResult = await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Amelia",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext(),
      );
      expect(loadingResult.handlerCount).toBe(0);
      expect(testGlobal.__lettaAdapterEvents).toEqual([]);

      await adapter.reload();

      expect(adapter.getSnapshot()).toMatchObject({
        hasModSources: true,
        isLoading: false,
      });
      expect(adapter.getSnapshot().registry.loadedPaths).toHaveLength(1);

      await adapter.events.emit(
        "conversation_open",
        {
          agentId: "agent-1",
          agentName: "Updated Agent",
          conversationId: "conversation-1",
          reason: "startup",
        },
        createModContext("Updated Agent"),
      );

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
