import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import type { Backend } from "@/backend";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import { createModEngine, type ModEngine } from "@/mods/mod-engine";
import {
  clearModPermissions,
  getModPermissionDefinition,
} from "@/mods/permission-registry";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";
import type { ModCapabilities, ModContext, ModPanelHandle } from "@/mods/types";

type ModTestGlobal = typeof globalThis & {
  __lettaModBackend?: unknown;
  __lettaModBackendCalls?: string[];
  __lettaModForkResult?: { id: string };
  __lettaModHistoryResult?: string[];
  __lettaModCapabilities?: ModCapabilities;
  __lettaModEvents?: string[];
  __lettaModGate?: Promise<void>;
  __lettaModPanel?: ModPanelHandle;
  __lettaModSignal?: AbortSignal;
  __lettaModStarted?: () => void;
  __lettaSwapBackend?: () => void;
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-engine-"));
}

function createModContext(): ModContext {
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
    agent: { id: "agent-1", name: "Amelia" },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
  };
}

function createEngine(
  root: string,
  capabilities?: ModCapabilities,
  backend?: Backend,
): ModEngine {
  return createModEngine({
    cacheDirectory: path.join(root, "mod-cache"),
    ...(backend ? { getBackend: () => backend } : {}),
    ...(capabilities ? { capabilities } : {}),
    getClient: async () => ({}) as unknown as Letta,
    getContext: createModContext,
    globalModsDirectory: path.join(root, "global-mods"),
  });
}

const TOOL_ONLY_MOD_CAPABILITIES: ModCapabilities = {
  tools: true,
  commands: false,
  events: { lifecycle: false, tools: false, turns: false },
  permissions: false,
  providers: false,
  ui: {
    panels: false,
    statusValues: false,
    customStatuslineRenderer: false,
  },
};

describe("mod engine", () => {
  afterEach(() => {
    clearModPermissions();
    clearModTools();
    clearRegisteredPiProviders();
  });

  test("reload publishes snapshots with owner metadata", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "command.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.commands.register({
            id: "hello",
            description: "Say hello",
            run() { return { type: "output", output: "hello" }; },
          });
        }`,
      );

      const engine = createEngine(root);
      let changes = 0;
      const unsubscribe = engine.subscribe(() => {
        changes += 1;
      });

      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(changes).toBeGreaterThan(0);
      expect(snapshot.loadedPaths).toEqual([modPath]);
      expect(snapshot.commands.hello?.owner).toMatchObject({
        generation: 1,
        id: `global:${modPath}`,
        path: modPath,
        scope: "global",
      });
      expect(engine.getSnapshot()).toBe(snapshot);

      unsubscribe();
      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("exposes configured capabilities to mods", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    delete testGlobal.__lettaModCapabilities;

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "capabilities.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          globalThis.__lettaModCapabilities = letta.capabilities;
          if (letta.capabilities.commands) {
            letta.commands.register({
              id: "hidden",
              description: "Should not register",
              run() { return { type: "handled" }; },
            });
          }
          if (letta.capabilities.ui.panels) {
            letta.ui.openPanel({ id: "hidden", content: "hidden" });
          }
          if (letta.capabilities.tools) {
            letta.tools.register({
              name: "visible_tool",
              description: "Visible tool",
              run() { return "ok"; },
            });
          }
        }`,
      );

      const engine = createEngine(root, TOOL_ONLY_MOD_CAPABILITIES);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      const observedCapabilities = testGlobal.__lettaModCapabilities as
        | ModCapabilities
        | undefined;
      expect(observedCapabilities).toEqual(TOOL_ONLY_MOD_CAPABILITIES);
      expect(snapshot.capabilities).toEqual(TOOL_ONLY_MOD_CAPABILITIES);
      expect(Object.keys(snapshot.commands)).toEqual([]);
      expect(Object.values(snapshot.ui.panels)).toEqual([]);
      expect(Object.keys(snapshot.tools)).toEqual(["visible_tool"]);
    } finally {
      delete testGlobal.__lettaModCapabilities;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("keeps backend internal and exposes scoped conversation helpers to events", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    delete testGlobal.__lettaModBackend;
    delete testGlobal.__lettaModForkResult;

    const backend = {
      forkConversation: async (
        ...[conversationId, options]: Parameters<Backend["forkConversation"]>
      ) => ({
        id: `${conversationId}:${options?.agentId}:${options?.hidden ? "hidden" : "visible"}`,
      }),
    } as unknown as Backend;

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "backend.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default async function(letta) {
          globalThis.__lettaModBackend = letta.backend;
          letta.events.on("conversation_open", async (_event, ctx) => {
            globalThis.__lettaModForkResult = await ctx.conversation.fork({ hidden: true });
          });
        }`,
      );

      const engine = createEngine(root, undefined, backend);
      await engine.reload();
      await engine.emitEvent("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conv-1",
        reason: "startup",
      });

      const forkResult = testGlobal.__lettaModForkResult as
        | { id: string }
        | undefined;
      expect(testGlobal.__lettaModBackend).toBeUndefined();
      expect(forkResult).toMatchObject({
        id: "conv-1:agent-1:hidden",
      });
      expect(getModErrorDiagnostics(engine.getSnapshot().diagnostics)).toEqual(
        [],
      );
    } finally {
      delete testGlobal.__lettaModBackend;
      delete testGlobal.__lettaModForkResult;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("captures backend once per event invocation for composed conversation helpers", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    testGlobal.__lettaModBackendCalls = [];
    delete testGlobal.__lettaModHistoryResult;
    delete testGlobal.__lettaSwapBackend;

    const createBackend = (label: string) =>
      ({
        forkConversation: async (
          ...[conversationId, options]: Parameters<Backend["forkConversation"]>
        ) => {
          testGlobal.__lettaModBackendCalls?.push(
            `${label}:fork:${conversationId}:${options?.agentId}:${options?.hidden}`,
          );
          return { id: `${label}-forked-conversation` };
        },
        listConversationMessages: async (
          ...[conversationId, body]: Parameters<
            Backend["listConversationMessages"]
          >
        ) => {
          testGlobal.__lettaModBackendCalls?.push(
            `${label}:history:${conversationId}:${body?.limit}`,
          );
          return {
            getPaginatedItems: () => [{ id: `${label}-message` }],
          };
        },
      }) as unknown as Backend;

    const backendA = createBackend("a");
    const backendB = createBackend("b");
    let activeBackend = backendA;
    testGlobal.__lettaSwapBackend = () => {
      activeBackend = backendB;
    };

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "scoped-backend.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.events.on("conversation_open", async (_event, ctx) => {
            const fork = await ctx.conversation.fork({ hidden: true });
            globalThis.__lettaSwapBackend();
            const history = await fork.getHistory({ limit: 1 });
            globalThis.__lettaModHistoryResult = history.map((message) => message.id);
          });
        }`,
      );

      const engine = createModEngine({
        cacheDirectory: path.join(root, "mod-cache"),
        getBackend: () => activeBackend,
        getClient: async () => ({}) as unknown as Letta,
        getContext: createModContext,
        globalModsDirectory: modDir,
      });
      await engine.reload();
      await engine.emitEvent("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conv-1",
        reason: "startup",
      });

      expect(testGlobal.__lettaModBackendCalls).toEqual([
        "a:fork:conv-1:agent-1:true",
        "a:history:a-forked-conversation:1",
      ]);
      const historyResult = (globalThis as ModTestGlobal)
        .__lettaModHistoryResult;
      expect(historyResult).toEqual(["a-message"]);
    } finally {
      delete testGlobal.__lettaModBackendCalls;
      delete testGlobal.__lettaModHistoryResult;
      delete testGlobal.__lettaSwapBackend;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets mods register pi providers for local backend", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "provider.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.registerProvider("lmstudio", {
            baseUrl: "http://localhost:8000/v1",
            apiKey: "not-needed",
            api: "openai-completions",
            models: [{
              id: "gemma-4-26B-A4B-it-oQ6",
              name: "Gemma 4 VLM",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            }],
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();

      expect(
        getRegisteredPiProvider("lmstudio")?.config.models?.[0],
      ).toMatchObject({
        id: "gemma-4-26B-A4B-it-oQ6",
        input: ["text", "image"],
        contextWindow: 256000,
        reasoning: true,
      });

      engine.dispose();
      expect(getRegisteredPiProvider("lmstudio")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("unsupported capabilities no-op even when mods call the APIs", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "unsupported.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "hidden",
            description: "Should not register",
            run() { return { type: "handled" }; },
          });
          letta.ui.openPanel({ id: "hidden", content: "hidden" });
          letta.ui.setStatus("hidden", "hidden");
          letta.ui.setStatuslineRenderer(() => "hidden");
          letta.events.on("conversation_open", () => {});
          letta.events.on("tool_start", () => {});
          letta.tools.register({
            name: "visible_tool",
            description: "Visible tool",
            run() { return "ok"; },
          });
        }`,
      );

      const engine = createEngine(root, TOOL_ONLY_MOD_CAPABILITIES);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getModErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.commands).toEqual({});
      expect(snapshot.events).toEqual({});
      expect(snapshot.ui.panels).toEqual({});
      expect(snapshot.ui.statusValues).toEqual({});
      expect(snapshot.ui.statuslineRenderer).toBeNull();
      expect(Object.keys(snapshot.tools)).toEqual(["visible_tool"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("emits mod lifecycle events and isolates handler errors", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    testGlobal.__lettaModEvents = [];

    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "events.ts"),
        `export default function(letta) {
          letta.events.on("conversation_open", (event, ctx) => {
            globalThis.__lettaModEvents.push(
              event.reason + ":" + event.agentId + ":" + ctx.context.agent.name + ":" + ctx.conversation.id,
            );
            letta.ui.setStatus("lifecycle", event.reason);
          });
          letta.events.on("conversation_open", () => {
            throw new Error("event failed");
          });
        }`,
      );

      const backend = {
        forkConversation: async () => ({ id: "forked" }),
      } as unknown as Backend;
      const engine = createEngine(root, undefined, backend);
      await engine.reload();
      expect(engine.getSnapshot().events.conversation_open).toHaveLength(2);

      const result = await engine.emitEvent("conversation_open", {
        agentId: "agent-1",
        agentName: "Amelia",
        conversationId: "conversation-1",
        reason: "startup",
      });

      const snapshot = engine.getSnapshot();
      expect(result).toMatchObject({
        handlerCount: 2,
        name: "conversation_open",
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(testGlobal.__lettaModEvents).toEqual([
        "startup:agent-1:Amelia:conversation-1",
      ]);
      expect(snapshot.ui.statusValues.lifecycle).toBe("startup");
      expect(getModErrorDiagnostics(snapshot.diagnostics).at(-1)).toMatchObject(
        {
          phase: "event",
          error: expect.objectContaining({ message: "event failed" }),
        },
      );

      engine.dispose();
    } finally {
      delete testGlobal.__lettaModEvents;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets turn_start handlers replace input in registration order", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "turn-start.ts"),
        `export default function(letta) {
          letta.events.on("turn_start", (event) => ({
            input: event.input.map((item) =>
              item.role === "user"
                ? { ...item, content: String(item.content).replaceAll("??", "first") }
                : item,
            ),
          }));
          letta.events.on("turn_start", (event) => {
            event.input = event.input.map((item) =>
              item.role === "user"
                ? { ...item, content: String(item.content).replaceAll("first", "second") }
                : item,
            );
          });
          letta.events.on("turn_start", (event) => {
            event.input = event.input.map((item) =>
              item.role === "user"
                ? { ...item, content: "broken" }
                : item,
            );
            throw new Error("turn_start failed");
          });
          letta.events.on("turn_start", (event) => {
            event.input = event.input.map((item) =>
              item.role === "user"
                ? { ...item, content: String(item.content).replaceAll("second", "final") }
                : item,
            );
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const event = {
        agentId: "agent-1",
        conversationId: "conversation-1",
        input: [{ role: "user" as const, content: "hello ??" }],
      };

      const result = await engine.emitEvent("turn_start", event);

      expect(result).toMatchObject({
        handlerCount: 4,
        name: "turn_start",
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.results).toHaveLength(1);
      expect(event.input).toEqual([{ role: "user", content: "hello final" }]);

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets tool_start handlers replace args in registration order", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "tool-start.ts"),
        `export default function(letta) {
          letta.events.on("tool_start", (event) => ({
            args: { ...event.args, command: String(event.args.command).replaceAll("??", "first") },
          }));
          letta.events.on("tool_start", (event) => {
            event.args = {
              ...event.args,
              command: String(event.args.command).replaceAll("first", "second"),
            };
          });
          letta.events.on("tool_start", (event) => {
            event.args = { ...event.args, command: "broken" };
            throw new Error("tool_start failed");
          });
          letta.events.on("tool_start", (event) => {
            event.args = {
              ...event.args,
              command: String(event.args.command).replaceAll("second", "final"),
            };
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const event = {
        agentId: "agent-1",
        conversationId: "conversation-1",
        toolCallId: "toolu-1",
        toolName: "Bash",
        args: { command: "echo ??" },
      };

      const result = await engine.emitEvent("tool_start", event);

      expect(result).toMatchObject({
        handlerCount: 4,
        name: "tool_start",
      });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.results).toHaveLength(1);
      expect(event.args).toEqual({ command: "echo final" });

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload aborts old activations and ignores stale handles", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    delete testGlobal.__lettaModPanel;
    delete testGlobal.__lettaModSignal;

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "panel.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          globalThis.__lettaModSignal = letta.signal;
          globalThis.__lettaModPanel = letta.ui.openPanel({
            id: "status",
            content: "first generation",
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const firstSignal = testGlobal.__lettaModSignal as
        | AbortSignal
        | undefined;
      const stalePanel = testGlobal.__lettaModPanel as
        | ModPanelHandle
        | undefined;
      expect(firstSignal?.aborted).toBe(false);
      expect(Object.values(engine.getSnapshot().ui.panels)).toHaveLength(1);

      writeFileSync(
        modPath,
        `export default function(letta) {
          globalThis.__lettaModSignal = letta.signal;
        }`,
      );
      await engine.reload();

      expect(firstSignal?.aborted).toBe(true);
      expect(Object.values(engine.getSnapshot().ui.panels)).toEqual([]);

      stalePanel?.update({ content: "stale update" });
      const snapshot = engine.getSnapshot();
      expect(Object.values(snapshot.ui.panels)).toEqual([]);
      expect(snapshot.diagnostics.at(-1)).toMatchObject({
        capability: { id: "status", kind: "panel" },
        phase: "stale_handle",
      });

      engine.dispose();
      const secondSignal = testGlobal.__lettaModSignal as
        | AbortSignal
        | undefined;
      expect(secondSignal?.aborted).toBe(true);
    } finally {
      delete testGlobal.__lettaModPanel;
      delete testGlobal.__lettaModSignal;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload publishes an empty snapshot while mods are loading", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    delete testGlobal.__lettaModGate;
    delete testGlobal.__lettaModStarted;

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "command.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.commands.register({
            id: "old-command",
            description: "Old command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      expect(Object.keys(engine.getSnapshot().commands)).toEqual([
        "old-command",
      ]);

      let releaseReload!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        testGlobal.__lettaModStarted = resolve;
      });
      testGlobal.__lettaModGate = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      writeFileSync(
        modPath,
        `export default async function(letta) {
          globalThis.__lettaModStarted?.();
          await globalThis.__lettaModGate;
          letta.commands.register({
            id: "new-command",
            description: "New command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const reloadPromise = engine.reload();
      await reloadStarted;

      expect(engine.getSnapshot().commands).toEqual({});
      expect(engine.getSnapshot().loadedPaths).toEqual([]);

      releaseReload();
      await reloadPromise;
      expect(Object.keys(engine.getSnapshot().commands)).toEqual([
        "new-command",
      ]);

      engine.dispose();
    } finally {
      delete testGlobal.__lettaModGate;
      delete testGlobal.__lettaModStarted;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("ignores stale reload completions", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ModTestGlobal;
    delete testGlobal.__lettaModGate;
    delete testGlobal.__lettaModStarted;

    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "command.ts");
      mkdirSync(modDir, { recursive: true });
      let releaseFirstReload!: () => void;
      const firstReloadStarted = new Promise<void>((resolve) => {
        testGlobal.__lettaModStarted = resolve;
      });
      testGlobal.__lettaModGate = new Promise<void>((resolve) => {
        releaseFirstReload = resolve;
      });
      writeFileSync(
        modPath,
        `export default async function(letta) {
          globalThis.__lettaModStarted?.();
          await globalThis.__lettaModGate;
          letta.commands.register({
            id: "stale-command",
            description: "Stale command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const engine = createEngine(root);
      const firstReload = engine.reload();
      await firstReloadStarted;

      delete testGlobal.__lettaModGate;
      delete testGlobal.__lettaModStarted;
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.commands.register({
            id: "fresh-command",
            description: "Fresh command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      await engine.reload();
      expect(Object.keys(engine.getSnapshot().commands)).toEqual([
        "fresh-command",
      ]);

      releaseFirstReload();
      await firstReload;

      const snapshot = engine.getSnapshot();
      expect(snapshot.generation).toBe(2);
      expect(Object.keys(snapshot.commands)).toEqual(["fresh-command"]);

      engine.dispose();
    } finally {
      delete testGlobal.__lettaModGate;
      delete testGlobal.__lettaModStarted;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records load diagnostics with specific phases", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "phase-activate.js"),
        `export default function() { throw new Error("activate failed"); }`,
      );
      writeFileSync(
        path.join(modDir, "phase-import.js"),
        `import "missing-mod-test-package";
         export default function() {}`,
      );
      writeFileSync(
        path.join(modDir, "phase-transpile.ts"),
        `export default function() { const value = ; }`,
      );

      const engine = createEngine(root);
      await engine.reload();

      expect(
        Object.fromEntries(
          getModErrorDiagnostics(engine.getSnapshot().diagnostics).map(
            (entry) => [path.basename(entry.owner.path), entry.phase],
          ),
        ),
      ).toEqual({
        "phase-activate.js": "activate",
        "phase-import.js": "import",
        "phase-transpile.ts": "transpile",
      });

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets mods report diagnostics intentionally", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "reports.ts"),
        `export default function(letta) {
          letta.diagnostics.report({ message: "missing optional env" });
          letta.diagnostics.report({ message: "configuration failed", severity: "error" });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const diagnostics = engine.getSnapshot().diagnostics;

      expect(diagnostics).toMatchObject([
        {
          error: expect.objectContaining({
            message: "missing optional env",
            name: "ModDiagnosticReport",
          }),
          phase: "report",
          severity: "error",
        },
        {
          error: expect.objectContaining({
            message: "configuration failed",
            name: "ModDiagnosticReport",
          }),
          phase: "report",
          severity: "error",
        },
      ]);
      expect(getModErrorDiagnostics(diagnostics)).toHaveLength(2);

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads mod-provided tools with owner metadata", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "tools.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          return letta.tools.register({
            name: "local_weather",
            description: "Get local weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
            requiresApproval: false,
            parallelSafe: true,
            run(ctx) { return "weather for " + ctx.args.city; },
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getModErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.tools.local_weather).toMatchObject({
        description: "Get local weather",
        owner: {
          generation: 1,
          id: `global:${modPath}`,
          path: modPath,
        },
        parallelSafe: true,
        requiresApproval: false,
      });
      expect(getModToolDefinition("local_weather")).toBeDefined();

      engine.dispose();
      expect(getModToolDefinition("local_weather")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads mod-provided permission overlays with owner metadata", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "permissions.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          return letta.permissions.register({
            id: "plan-mode",
            description: "Allow reads and plan-file writes while planning",
            check(event) {
              if (event.toolName === "Write") {
                return { decision: "deny", reason: "write blocked while planning" };
              }
            },
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getModErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.permissions["plan-mode"]).toMatchObject({
        description: "Allow reads and plan-file writes while planning",
        owner: {
          generation: 1,
          id: `global:${modPath}`,
          path: modPath,
        },
      });
      expect(getModPermissionDefinition("plan-mode")).toBeDefined();

      engine.dispose();
      expect(getModPermissionDefinition("plan-mode")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
