import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import {
  createExtensionHost,
  type ExtensionHost,
} from "@/extensions/extension-host";
import type { ExtensionPanelHandle } from "@/extensions/types";

type ExtensionTestGlobal = typeof globalThis & {
  __lettaExtensionPanel?: ExtensionPanelHandle;
  __lettaExtensionSignal?: AbortSignal;
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extension-host-"));
}

function createHost(root: string): ExtensionHost {
  return createExtensionHost({
    cacheDirectory: path.join(root, "extension-cache"),
    getClient: async () => ({}) as unknown as Letta,
    globalExtensionsDirectory: path.join(root, "global-extensions"),
  });
}

describe("extension host", () => {
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
});
