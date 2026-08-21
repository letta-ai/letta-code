import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import {
  disposeLocalMods,
  type LocalModRegistry,
  loadLocalMods,
} from "@/mods/mod-engine";
import type { ModPanelHandle } from "@/mods/types";

type ModBatchingTestGlobal = typeof globalThis & {
  __modBatchingPanel?: ModPanelHandle;
};

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-change-batcher-"));
}

function createLoadOptions(root: string) {
  return {
    cacheDirectory: path.join(root, "mod-cache"),
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: path.join(root, "global-mods"),
    registerCapabilitiesGlobally: false,
  };
}

test("coalesces real mod lifecycle changes without delaying runtime updates", async () => {
  const root = createTempDir();
  const testGlobal = globalThis as ModBatchingTestGlobal;
  let registry: LocalModRegistry | null = null;
  delete testGlobal.__modBatchingPanel;

  try {
    const options = createLoadOptions(root);
    mkdirSync(options.globalModsDirectory, { recursive: true });
    writeFileSync(
      path.join(options.globalModsDirectory, "many-panels.ts"),
      `export default async function(letta) {
        const panels = [];
        const register = (index) => {
          panels.push(letta.ui.openPanel({
            id: "status-" + index,
            render: () => "panel-" + index,
          }));
        };
        for (let index = 0; index < 10; index += 1) register(index);
        await Promise.resolve();
        for (let index = 10; index < 20; index += 1) register(index);
        globalThis.__modBatchingPanel = panels[0];
        return () => {
          for (const panel of panels) panel.close();
        };
      }`,
    );

    let changes = 0;
    registry = await loadLocalMods({
      ...options,
      onChange: () => {
        changes += 1;
      },
    });

    expect(Object.values(registry.ui.panels)).toHaveLength(20);
    expect(changes).toBe(1);

    const panel = testGlobal.__modBatchingPanel as ModPanelHandle | undefined;
    expect(panel).toBeDefined();
    panel?.update();
    expect(changes).toBe(2);

    disposeLocalMods(registry);
    registry = null;
    expect(changes).toBe(3);
  } finally {
    if (registry) disposeLocalMods(registry);
    delete testGlobal.__modBatchingPanel;
    rmSync(root, { force: true, recursive: true });
  }
});

test("does not publish capabilities from a failed activation", async () => {
  const root = createTempDir();
  let registry: LocalModRegistry | null = null;

  try {
    const options = createLoadOptions(root);
    mkdirSync(options.globalModsDirectory, { recursive: true });
    writeFileSync(
      path.join(options.globalModsDirectory, "failed.ts"),
      `export default function(letta) {
        letta.ui.openPanel({ id: "partial", render: () => "partial" });
        throw new Error("activation failed");
      }`,
    );

    let changes = 0;
    registry = await loadLocalMods({
      ...options,
      onChange: () => {
        changes += 1;
      },
    });

    expect(changes).toBe(0);
    expect(registry.ui.panels).toEqual({});
    expect(registry.loadedPaths).toEqual([]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ phase: "activate" }),
    );
  } finally {
    if (registry) disposeLocalMods(registry);
    rmSync(root, { force: true, recursive: true });
  }
});
