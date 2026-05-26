import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import {
  createExtensionHost,
  type ExtensionHost,
} from "@/extensions/extension-host";
import {
  clearExtensionTools,
  getExtensionToolDefinition,
} from "@/extensions/tool-registry";
import type {
  ExtensionCapabilities,
  ExtensionPanelHandle,
} from "@/extensions/types";

type ExtensionTestGlobal = typeof globalThis & {
  __lettaExtensionCapabilities?: ExtensionCapabilities;
  __lettaExtensionGate?: Promise<void>;
  __lettaExtensionPanel?: ExtensionPanelHandle;
  __lettaExtensionSignal?: AbortSignal;
  __lettaExtensionStarted?: () => void;
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extension-host-"));
}

function createHost(
  root: string,
  capabilities?: ExtensionCapabilities,
): ExtensionHost {
  return createExtensionHost({
    cacheDirectory: path.join(root, "extension-cache"),
    ...(capabilities ? { capabilities } : {}),
    getClient: async () => ({}) as unknown as Letta,
    globalExtensionsDirectory: path.join(root, "global-extensions"),
  });
}

const TOOL_ONLY_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
  tools: true,
  commands: false,
  ui: {
    panels: false,
    statusValues: false,
    customStatuslineRenderer: false,
  },
};

describe("extension host", () => {
  afterEach(() => {
    clearExtensionTools();
  });

  test("reload publishes snapshots with owner metadata", async () => {
    const root = createTempDir();
    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "command.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          letta.commands.register({
            id: "hello",
            description: "Say hello",
            run() { return { type: "output", output: "hello" }; },
          });
        }`,
      );

      const host = createHost(root);
      let changes = 0;
      const unsubscribe = host.subscribe(() => {
        changes += 1;
      });

      await host.reload();
      const snapshot = host.getSnapshot();

      expect(changes).toBeGreaterThan(0);
      expect(snapshot.loadedPaths).toEqual([extensionPath]);
      expect(snapshot.commands.hello?.owner).toMatchObject({
        generation: 1,
        id: `global:${extensionPath}`,
        path: extensionPath,
        scope: "global",
      });
      expect(host.getSnapshot()).toBe(snapshot);

      unsubscribe();
      host.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("exposes configured capabilities to extensions", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionTestGlobal;
    delete testGlobal.__lettaExtensionCapabilities;

    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "capabilities.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          globalThis.__lettaExtensionCapabilities = letta.capabilities;
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

      const host = createHost(root, TOOL_ONLY_EXTENSION_CAPABILITIES);
      await host.reload();
      const snapshot = host.getSnapshot();

      const observedCapabilities = testGlobal.__lettaExtensionCapabilities as
        | ExtensionCapabilities
        | undefined;
      expect(observedCapabilities).toEqual(TOOL_ONLY_EXTENSION_CAPABILITIES);
      expect(snapshot.capabilities).toEqual(TOOL_ONLY_EXTENSION_CAPABILITIES);
      expect(Object.keys(snapshot.commands)).toEqual([]);
      expect(Object.values(snapshot.ui.panels)).toEqual([]);
      expect(Object.keys(snapshot.tools)).toEqual(["visible_tool"]);
    } finally {
      delete testGlobal.__lettaExtensionCapabilities;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("unsupported capabilities no-op even when extensions call the APIs", async () => {
    const root = createTempDir();
    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "unsupported.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "hidden",
            description: "Should not register",
            run() { return { type: "handled" }; },
          });
          letta.ui.openPanel({ id: "hidden", content: "hidden" });
          letta.ui.setStatus("hidden", "hidden");
          letta.ui.setStatuslineRenderer(() => "hidden");
          letta.tools.register({
            name: "visible_tool",
            description: "Visible tool",
            run() { return "ok"; },
          });
        }`,
      );

      const host = createHost(root, TOOL_ONLY_EXTENSION_CAPABILITIES);
      await host.reload();
      const snapshot = host.getSnapshot();

      expect(snapshot.errors).toEqual([]);
      expect(snapshot.commands).toEqual({});
      expect(snapshot.ui.panels).toEqual({});
      expect(snapshot.ui.statusValues).toEqual({});
      expect(snapshot.ui.statuslineRenderer).toBeNull();
      expect(Object.keys(snapshot.tools)).toEqual(["visible_tool"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload aborts old activations and ignores stale handles", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionTestGlobal;
    delete testGlobal.__lettaExtensionPanel;
    delete testGlobal.__lettaExtensionSignal;

    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "panel.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          globalThis.__lettaExtensionSignal = letta.signal;
          globalThis.__lettaExtensionPanel = letta.ui.openPanel({
            id: "status",
            content: "first generation",
          });
        }`,
      );

      const host = createHost(root);
      await host.reload();
      const firstSignal = testGlobal.__lettaExtensionSignal as
        | AbortSignal
        | undefined;
      const stalePanel = testGlobal.__lettaExtensionPanel as
        | ExtensionPanelHandle
        | undefined;
      expect(firstSignal?.aborted).toBe(false);
      expect(Object.values(host.getSnapshot().ui.panels)).toHaveLength(1);

      writeFileSync(
        extensionPath,
        `export default function(letta) {
          globalThis.__lettaExtensionSignal = letta.signal;
        }`,
      );
      await host.reload();

      expect(firstSignal?.aborted).toBe(true);
      expect(Object.values(host.getSnapshot().ui.panels)).toEqual([]);

      stalePanel?.update({ content: "stale update" });
      const snapshot = host.getSnapshot();
      expect(Object.values(snapshot.ui.panels)).toEqual([]);
      expect(snapshot.diagnostics.at(-1)).toMatchObject({
        capability: { id: "status", kind: "panel" },
        phase: "stale_handle",
      });

      host.dispose();
      const secondSignal = testGlobal.__lettaExtensionSignal as
        | AbortSignal
        | undefined;
      expect(secondSignal?.aborted).toBe(true);
    } finally {
      delete testGlobal.__lettaExtensionPanel;
      delete testGlobal.__lettaExtensionSignal;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reload publishes an empty snapshot while extensions are loading", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionTestGlobal;
    delete testGlobal.__lettaExtensionGate;
    delete testGlobal.__lettaExtensionStarted;

    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "command.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          letta.commands.register({
            id: "old-command",
            description: "Old command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const host = createHost(root);
      await host.reload();
      expect(Object.keys(host.getSnapshot().commands)).toEqual(["old-command"]);

      let releaseReload!: () => void;
      const reloadStarted = new Promise<void>((resolve) => {
        testGlobal.__lettaExtensionStarted = resolve;
      });
      testGlobal.__lettaExtensionGate = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      writeFileSync(
        extensionPath,
        `export default async function(letta) {
          globalThis.__lettaExtensionStarted?.();
          await globalThis.__lettaExtensionGate;
          letta.commands.register({
            id: "new-command",
            description: "New command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const reloadPromise = host.reload();
      await reloadStarted;

      expect(host.getSnapshot().commands).toEqual({});
      expect(host.getSnapshot().loadedPaths).toEqual([]);

      releaseReload();
      await reloadPromise;
      expect(Object.keys(host.getSnapshot().commands)).toEqual(["new-command"]);

      host.dispose();
    } finally {
      delete testGlobal.__lettaExtensionGate;
      delete testGlobal.__lettaExtensionStarted;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("ignores stale reload completions", async () => {
    const root = createTempDir();
    const testGlobal = globalThis as ExtensionTestGlobal;
    delete testGlobal.__lettaExtensionGate;
    delete testGlobal.__lettaExtensionStarted;

    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "command.ts");
      mkdirSync(extensionDir, { recursive: true });
      let releaseFirstReload!: () => void;
      const firstReloadStarted = new Promise<void>((resolve) => {
        testGlobal.__lettaExtensionStarted = resolve;
      });
      testGlobal.__lettaExtensionGate = new Promise<void>((resolve) => {
        releaseFirstReload = resolve;
      });
      writeFileSync(
        extensionPath,
        `export default async function(letta) {
          globalThis.__lettaExtensionStarted?.();
          await globalThis.__lettaExtensionGate;
          letta.commands.register({
            id: "stale-command",
            description: "Stale command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const host = createHost(root);
      const firstReload = host.reload();
      await firstReloadStarted;

      delete testGlobal.__lettaExtensionGate;
      delete testGlobal.__lettaExtensionStarted;
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          letta.commands.register({
            id: "fresh-command",
            description: "Fresh command",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      await host.reload();
      expect(Object.keys(host.getSnapshot().commands)).toEqual([
        "fresh-command",
      ]);

      releaseFirstReload();
      await firstReload;

      const snapshot = host.getSnapshot();
      expect(snapshot.generation).toBe(2);
      expect(Object.keys(snapshot.commands)).toEqual(["fresh-command"]);

      host.dispose();
    } finally {
      delete testGlobal.__lettaExtensionGate;
      delete testGlobal.__lettaExtensionStarted;
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records load diagnostics with specific phases", async () => {
    const root = createTempDir();
    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "phase-activate.js"),
        `export default function() { throw new Error("activate failed"); }`,
      );
      writeFileSync(
        path.join(extensionDir, "phase-import.js"),
        `import "missing-extension-test-package";
         export default function() {}`,
      );
      writeFileSync(
        path.join(extensionDir, "phase-transpile.ts"),
        `export default function() { const value = ; }`,
      );

      const host = createHost(root);
      await host.reload();

      expect(
        Object.fromEntries(
          host
            .getSnapshot()
            .errors.map((entry) => [path.basename(entry.path), entry.phase]),
        ),
      ).toEqual({
        "phase-activate.js": "activate",
        "phase-import.js": "import",
        "phase-transpile.ts": "transpile",
      });

      host.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads extension-provided tools with owner metadata", async () => {
    const root = createTempDir();
    try {
      const extensionDir = path.join(root, "global-extensions");
      const extensionPath = path.join(extensionDir, "tools.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
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

      const host = createHost(root);
      await host.reload();
      const snapshot = host.getSnapshot();

      expect(snapshot.errors).toEqual([]);
      expect(snapshot.tools.local_weather).toMatchObject({
        description: "Get local weather",
        owner: {
          generation: 1,
          id: `global:${extensionPath}`,
          path: extensionPath,
        },
        parallelSafe: true,
        requiresApproval: false,
      });
      expect(getExtensionToolDefinition("local_weather")).toBeDefined();

      host.dispose();
      expect(getExtensionToolDefinition("local_weather")).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
