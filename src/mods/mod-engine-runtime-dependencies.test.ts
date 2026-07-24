import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import {
  __testOverrideRuntimePackageDirectoryResolver,
  createModEngine,
  type ModEngine,
} from "@/mods/mod-engine";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-runtime-deps-"));
}

function createEngine(root: string): ModEngine {
  return createModEngine({
    cacheDirectory: path.join(root, "mod-cache"),
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: path.join(root, "global-mods"),
  });
}

function createStaleReactLink(root: string): string {
  const cacheNodeModules = path.join(root, "mod-cache", "node_modules");
  const reactLink = path.join(cacheNodeModules, "react");
  mkdirSync(cacheNodeModules, { recursive: true });
  symlinkSync(
    path.join(root, "missing-react"),
    reactLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  return reactLink;
}

describe("mod engine runtime dependencies", () => {
  afterEach(() => {
    __testOverrideRuntimePackageDirectoryResolver(null);
  });

  test("skips React resolution for TypeScript mods that do not import React", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "command.ts");
      mkdirSync(modDir, { recursive: true });
      const reactLink = createStaleReactLink(root);
      writeFileSync(
        modPath,
        `// import "react" should not count when it is just a comment.
        export default function(letta) {
          const note = 'dynamic import("react") text is not an import';
          letta.commands.register({
            id: "hello",
            description: "Say hello",
            run() { return { type: "output", output: "hello" }; },
          });
        }`,
      );
      __testOverrideRuntimePackageDirectoryResolver((packageName) => {
        throw new Error(`Cannot find module '${packageName}/package.json'`);
      });

      const engine = createEngine(root);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getModErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.loadedPaths).toEqual([modPath]);
      expect(readlinkSync(reactLink)).toContain("missing-react");

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("replaces stale React cache symlinks when React is imported", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "global-mods");
      const modPath = path.join(modDir, "panel.tsx");
      mkdirSync(modDir, { recursive: true });
      const reactLink = createStaleReactLink(root);
      writeFileSync(
        modPath,
        `export default function(letta) {
          const label = <span>hello</span>;
          letta.ui.openPanel({
            id: "hello",
            render() { return label.props.children; },
          });
        }`,
      );

      const engine = createEngine(root);
      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getModErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.loadedPaths).toEqual([modPath]);
      expect(readlinkSync(reactLink)).not.toContain("missing-react");

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
