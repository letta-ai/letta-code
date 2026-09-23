import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import { createModEngine } from "@/mods/mod-engine";
import {
  clearModPermissions,
  getModPermissionDefinition,
} from "@/mods/permission-registry";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";

// Regression coverage for duplicate mod loads: two engines in one process
// (the listener and session adapters) loading the same global mod file used
// to collide in the process-global tool/permission maps, aborting the second
// load mid-activation and leaving half the mod's capabilities unregistered.

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-dup-"));
}

const MOD_SOURCE = `export default function activate(letta) {
  letta.commands.register({
    id: "cruise",
    description: "Cruise",
    run() { return { type: "output", output: "cruising" }; },
  });
  letta.tools.register({
    name: "cruise_tool",
    description: "Cruise tool",
    parameters: { type: "object", properties: {} },
    run() { return "cruising"; },
  });
  letta.permissions.register({
    id: "cruise-perm",
    description: "Cruise permission",
    check() { return { decision: "ask" }; },
  });
}`;

function writeMod(root: string, name = "cruise.js", source = MOD_SOURCE) {
  const dir = path.join(root, "global-mods");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), source);
}

function createEngine(root: string) {
  return createModEngine({
    cacheDirectory: path.join(root, "mod-cache"),
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: path.join(root, "global-mods"),
  });
}

describe("duplicate mod registration", () => {
  afterEach(() => {
    clearModPermissions();
    clearModTools();
  });

  test("two engines in one process can both load the same global mod", async () => {
    const root = createTempDir();
    try {
      writeMod(root);

      // Simulates the listener adapter and session adapter in one process.
      const listenerEngine = createEngine(root);
      await listenerEngine.reload();
      const sessionEngine = createEngine(root);
      await sessionEngine.reload();

      expect(
        getModErrorDiagnostics(listenerEngine.getSnapshot().diagnostics),
      ).toEqual([]);
      expect(
        getModErrorDiagnostics(sessionEngine.getSnapshot().diagnostics),
      ).toEqual([]);

      // Both engines expose the mod's capabilities locally...
      expect(listenerEngine.getSnapshot().commands.cruise).toBeDefined();
      expect(sessionEngine.getSnapshot().commands.cruise).toBeDefined();
      expect(listenerEngine.getSnapshot().tools.cruise_tool).toBeDefined();
      expect(sessionEngine.getSnapshot().tools.cruise_tool).toBeDefined();

      // ...while the process-global maps hold the single shared entry.
      expect(getModToolDefinition("cruise_tool")?.path).toContain("cruise.js");
      expect(getModPermissionDefinition("cruise-perm")?.path).toContain(
        "cruise.js",
      );

      listenerEngine.dispose();
      sessionEngine.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a different mod file registering the same command id still throws", async () => {
    const root = createTempDir();
    try {
      writeMod(root);
      writeMod(
        root,
        "impostor.js",
        `export default function activate(letta) {
          letta.commands.register({
            id: "cruise",
            description: "Impostor",
            run() { return { type: "output", output: "nope" }; },
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();

      const errors = getModErrorDiagnostics(engine.getSnapshot().diagnostics);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error.message).toContain(
        "Mod command 'cruise' is already registered by",
      );
      // The real mod's registration survives the impostor's failure.
      expect(
        engine.getSnapshot().commands.cruise?.path.endsWith("cruise.js"),
      ).toBe(true);

      engine.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reload still re-registers after disposal", async () => {
    const root = createTempDir();
    try {
      writeMod(root);
      const engine = createEngine(root);
      await engine.reload();
      expect(engine.getSnapshot().commands.cruise).toBeDefined();

      await engine.reload();
      expect(getModErrorDiagnostics(engine.getSnapshot().diagnostics)).toEqual(
        [],
      );
      expect(engine.getSnapshot().commands.cruise).toBeDefined();
      expect(getModToolDefinition("cruise_tool")).toBeDefined();

      engine.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
