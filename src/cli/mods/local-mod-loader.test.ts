import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import chalk from "chalk";
import { columns, row } from "@/cli/display/statusline/formatting";
import { buildCliModContext } from "@/cli/helpers/cli-mod-context";
import { runModCommandWithTimeout } from "@/cli/mods/command-runtime";
import {
  disposeLocalMods,
  loadLocalMods,
  resolveLocalModSources,
} from "@/cli/mods/local-mod-loader";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import { clearModTools } from "@/mods/tool-registry";
import type { ModContext, ModDiagnostic } from "@/mods/types";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mods-"));
}

function createModContext(): ModContext {
  return buildCliModContext({
    agentName: "Letta Code",
    currentDirectory: "/tmp/project",
    modelDisplayName: "Sonnet 4.6",
    modelProvider: "anthropic",
    projectDirectory: "/tmp/project",
    toolset: "default",
  });
}

function renderCtx(width: number) {
  const context = createModContext();
  return {
    ...context,
    width,
    row,
    columns,
    chalk,
  };
}

function createLoadOptions(root: string) {
  return {
    cacheDirectory: path.join(root, "mod-cache"),
    getClient: async () =>
      ({ getMarker: () => "test-client" }) as unknown as Letta,
    globalModsDirectory: path.join(root, "global-mods"),
  };
}

describe("local mod loader", () => {
  afterEach(() => {
    clearModTools();
  });

  test("discovers global mod source", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      mkdirSync(globalMods, { recursive: true });
      writeFileSync(path.join(globalMods, "a.ts"), "export default () => {};");
      writeFileSync(path.join(globalMods, "b.tsx"), "export default () => {};");

      expect(
        resolveLocalModSources({
          globalModsDirectory: globalMods,
        }),
      ).toEqual([
        {
          files: [
            path.join(globalMods, "a.ts"),
            path.join(globalMods, "b.tsx"),
          ],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("discovers legacy extensions before global mods", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      const legacyExtensions = path.join(root, "legacy-extensions");
      const legacyPath = path.join(legacyExtensions, "review.ts");
      const modPath = path.join(globalMods, "web-search.ts");
      mkdirSync(globalMods, { recursive: true });
      mkdirSync(legacyExtensions, { recursive: true });
      writeFileSync(legacyPath, "export default () => {};\n");
      writeFileSync(modPath, "export default () => {};\n");

      expect(
        resolveLocalModSources({
          globalModsDirectory: globalMods,
          legacyGlobalExtensionsDirectory: legacyExtensions,
        }),
      ).toEqual([
        {
          files: [legacyPath],
          legacyMigrationTargetRoot: globalMods,
          root: legacyExtensions,
          scope: "legacy_global",
          trusted: true,
        },
        {
          files: [modPath],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("discovers agent mod source after global mod source", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      const agentMods = path.join(root, "memory", "mods");
      mkdirSync(globalMods, { recursive: true });
      mkdirSync(agentMods, { recursive: true });
      writeFileSync(
        path.join(globalMods, "global.ts"),
        "export default () => {};\n",
      );
      writeFileSync(
        path.join(agentMods, "agent.ts"),
        "export default () => {};\n",
      );

      expect(
        resolveLocalModSources({
          agentModsDirectory: agentMods,
          globalModsDirectory: globalMods,
        }),
      ).toEqual([
        {
          files: [path.join(globalMods, "global.ts")],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
        {
          files: [path.join(agentMods, "agent.ts")],
          root: agentMods,
          scope: "agent",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("discovers managed package entries after harness mod files", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      const packageRoot = path.join(
        globalMods,
        "packages",
        "npm",
        "@caren",
        "my-mod",
      );
      const packageMod = path.join(packageRoot, "mods", "index.ts");
      const packageExtra = path.join(packageRoot, "mods", "extra.ts");
      const modFile = path.join(globalMods, "mod-file.ts");
      mkdirSync(path.dirname(packageMod), { recursive: true });
      writeFileSync(modFile, "export default () => {};\n");
      writeFileSync(packageMod, "export default () => {};\n");
      writeFileSync(packageExtra, "export default () => {};\n");
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          letta: {
            manifestVersion: 1,
            mods: ["./mods/index.ts"],
          },
        }),
      );
      writeFileSync(
        path.join(globalMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/my-mod",
              version: "0.1.0",
              enabled: true,
              root: "packages/npm/@caren/my-mod",
              entries: ["./mods/index.ts"],
            },
          ],
        }),
      );

      expect(
        resolveLocalModSources({
          globalModsDirectory: globalMods,
        }),
      ).toEqual([
        {
          files: [modFile, packageMod],
          managedPackageRoots: [packageRoot],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("discovers managed package entries from the agent mods directory", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      const agentMods = path.join(root, "memory", "mods");
      const packageRoot = path.join(
        agentMods,
        "packages",
        "npm",
        "@caren",
        "agent-mod",
      );
      const packageMod = path.join(packageRoot, "mods", "index.ts");
      const agentModFile = path.join(agentMods, "agent.ts");
      mkdirSync(globalMods, { recursive: true });
      mkdirSync(path.dirname(packageMod), { recursive: true });
      writeFileSync(agentModFile, "export default () => {};\n");
      writeFileSync(packageMod, "export default () => {};\n");
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          letta: {
            manifestVersion: 1,
            mods: ["./mods/index.ts"],
          },
        }),
      );
      writeFileSync(
        path.join(agentMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/agent-mod",
              version: "0.1.0",
              enabled: true,
              root: "packages/npm/@caren/agent-mod",
              entries: ["./mods/index.ts"],
            },
          ],
        }),
      );

      expect(
        resolveLocalModSources({
          agentModsDirectory: agentMods,
          globalModsDirectory: globalMods,
        }),
      ).toEqual([
        {
          files: [],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
        {
          files: [agentModFile, packageMod],
          managedPackageRoots: [packageRoot],
          root: agentMods,
          scope: "agent",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("skips disabled managed packages", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      mkdirSync(globalMods, { recursive: true });
      writeFileSync(
        path.join(globalMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/my-disabled-mod",
              version: "0.1.0",
              enabled: false,
              root: "packages/npm/@caren/my-disabled-mod",
              entries: ["./mods/index.ts"],
            },
          ],
        }),
      );

      expect(
        resolveLocalModSources({
          globalModsDirectory: globalMods,
        }),
      ).toEqual([
        {
          files: [],
          root: globalMods,
          scope: "global",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reports invalid managed package manifests", () => {
    const root = createTempDir();
    try {
      const { globalModsDirectory: globalMods } = createLoadOptions(root);
      const packageRoot = path.join(
        globalMods,
        "packages",
        "npm",
        "@caren",
        "bad-mod",
      );
      const packageJsonPath = path.join(packageRoot, "package.json");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "@caren/bad-mod" }),
      );
      writeFileSync(
        path.join(globalMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/bad-mod",
              version: "0.1.0",
              enabled: true,
              root: "packages/npm/@caren/bad-mod",
              entries: ["./mods/index.ts"],
            },
          ],
        }),
      );

      const sources = resolveLocalModSources({
        globalModsDirectory: globalMods,
      });

      expect(sources).toHaveLength(1);
      expect(sources[0]?.files).toEqual([]);
      expect(sources[0]?.diagnostics).toHaveLength(1);
      expect(sources[0]?.diagnostics?.[0]?.path).toBe(packageJsonPath);
      expect(sources[0]?.diagnostics?.[0]?.error.message).toContain(
        "package.json#letta",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("does not initialize SDK client when no mod files exist", async () => {
    const root = createTempDir();
    try {
      const options = {
        ...createLoadOptions(root),
        getClient: async () => {
          throw new Error("client should not initialize without mods");
        },
      };

      const registry = await loadLocalMods(options);

      expect(registry.loadedPaths).toEqual([]);
      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("does not initialize SDK client until a mod uses it", async () => {
    const root = createTempDir();
    try {
      const options = {
        ...createLoadOptions(root),
        getClient: async () => {
          throw new Error("client should be lazy");
        },
      };
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "status.ts"),
        `export default function(letta) {
          letta.ui.openPanel({ id: "mode", render: () => "fast" });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      const panel = Object.values(registry.ui.panels)[0];
      expect(panel?.render(renderCtx(80))).toBe("fast");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("deprecated activation getContext trap records even when caught", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "legacy-statusline.ts"),
        `export default function(letta) {
          const update = async () => {
            try {
              letta.getContext();
            } catch {
              letta.ui.clearStatus("branch");
            }
          };
          void update();
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          capability: { id: "letta.getContext", kind: "api" },
          phase: "deprecated_api",
          severity: "warning",
        }),
      );
      expect(
        registry.diagnostics.some((diagnostic) =>
          diagnostic.error.message.includes(
            "letta.getContext is no longer available",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("static source scan records deprecated getContext warnings", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "ctx-source.ts"),
        `export default function() {
          const unused = (ctx) => ctx.getContext();
        }`,
      );
      writeFileSync(
        path.join(modDir, "generic-source.ts"),
        `export default function() {
          const unused = (value) => value.getContext();
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          capability: { id: "ctx.getContext", kind: "api" },
          error: expect.objectContaining({
            message: "Mod source uses removed API: ctx.getContext",
          }),
          phase: "deprecated_api",
          severity: "warning",
        }),
      );
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          capability: { id: ".getContext()", kind: "api" },
          error: expect.objectContaining({
            message: "Mod source uses removed API: .getContext()",
          }),
          phase: "deprecated_api",
          severity: "warning",
        }),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("transpiles TypeScript and TSX mods to importable mjs cache files", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      const modPath = path.join(modDir, "statusline.tsx");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta: any) {
          letta.ui.openPanel({
            id: "panel",
            render: (ctx: any) => <span>{ctx.agent.name}</span>,
          });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(registry.loadedPaths).toEqual([modPath]);
      const cacheFiles = readdirSync(options.cacheDirectory).filter((entry) =>
        entry.startsWith(".letta-mod-statusline-"),
      );
      expect(cacheFiles).toHaveLength(1);
      expect(cacheFiles[0]?.endsWith(".mjs")).toBe(true);
      const panel = Object.values(registry.ui.panels)[0];
      const output = panel?.render(renderCtx(80));
      expect(output).toMatchObject({ props: { children: "Letta Code" } });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads managed package mods with package node_modules imports", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const globalMods = options.globalModsDirectory;
      const packageRoot = path.join(
        globalMods,
        "packages",
        "npm",
        "@caren",
        "dep-mod",
      );
      const modDir = path.join(packageRoot, "mods");
      const dependencyRoot = path.join(packageRoot, "node_modules", "fake-dep");
      mkdirSync(modDir, { recursive: true });
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(
        path.join(modDir, "index.js"),
        `import { label } from "fake-dep";
export default function(letta) {
  letta.ui.openPanel({ id: "dep", render: () => label });
}
`,
      );
      writeFileSync(
        path.join(dependencyRoot, "package.json"),
        JSON.stringify({
          name: "fake-dep",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        }),
      );
      writeFileSync(
        path.join(dependencyRoot, "index.js"),
        `export const label = "dependency";\n`,
      );
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@caren/dep-mod",
          version: "0.1.0",
          letta: {
            manifestVersion: 1,
            mods: ["mods/index.js"],
          },
        }),
      );
      mkdirSync(globalMods, { recursive: true });
      writeFileSync(
        path.join(globalMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/dep-mod",
              version: "0.1.0",
              enabled: true,
              root: "packages/npm/@caren/dep-mod",
              entries: ["mods/index.js"],
            },
          ],
        }),
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      const panel = Object.values(registry.ui.panels)[0];
      expect(panel?.render(renderCtx(80))).toBe("dependency");
      const generatedFiles = readdirSync(modDir).filter((entry) =>
        entry.startsWith(".letta-mod-index-"),
      );
      expect(generatedFiles).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads agent managed package mods without writing import caches into memory", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const agentMods = path.join(root, "memory", "mods");
      const packageRoot = path.join(
        agentMods,
        "packages",
        "npm",
        "@caren",
        "agent-dep-mod",
      );
      const modDir = path.join(packageRoot, "mods");
      const dependencyRoot = path.join(packageRoot, "node_modules", "fake-dep");
      mkdirSync(modDir, { recursive: true });
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(
        path.join(modDir, "index.js"),
        `import { label } from "fake-dep";
export default function(letta) {
  letta.ui.openPanel({ id: "agent-dep", render: () => label });
}
`,
      );
      writeFileSync(
        path.join(dependencyRoot, "package.json"),
        JSON.stringify({
          name: "fake-dep",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        }),
      );
      writeFileSync(
        path.join(dependencyRoot, "index.js"),
        `export const label = "agent dependency";\n`,
      );
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@caren/agent-dep-mod",
          version: "0.1.0",
          letta: {
            manifestVersion: 1,
            mods: ["mods/index.js"],
          },
        }),
      );
      writeFileSync(
        path.join(agentMods, "packages.json"),
        JSON.stringify({
          packages: [
            {
              source: "npm:@caren/agent-dep-mod",
              version: "0.1.0",
              enabled: true,
              root: "packages/npm/@caren/agent-dep-mod",
              entries: ["mods/index.js"],
            },
          ],
        }),
      );

      const registry = await loadLocalMods({
        ...options,
        agentModsDirectory: agentMods,
      });

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      const panel = Object.values(registry.ui.panels)[0];
      expect(panel?.render(renderCtx(80))).toBe("agent dependency");
      const generatedFiles = readdirSync(modDir).filter((entry) =>
        entry.startsWith(".letta-mod-index-"),
      );
      expect(generatedFiles).toHaveLength(0);
      expect(
        existsSync(path.join(options.cacheDirectory, "managed-packages")),
      ).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("captures mod load errors without blocking other mods", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(path.join(modDir, "broken.ts"), "export const nope = 1;");
      writeFileSync(
        path.join(modDir, "working.ts"),
        `export default function(letta) {
          letta.ui.openPanel({ id: "ok", render: () => "true" });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(registry.loadedPaths).toEqual([path.join(modDir, "working.ts")]);
      const panel = Object.values(registry.ui.panels)[0];
      expect(panel?.render(renderCtx(80))).toBe("true");
      const errorDiagnostics = getModErrorDiagnostics(registry.diagnostics);
      expect(errorDiagnostics).toHaveLength(1);
      const [errorDiagnostic] = errorDiagnostics;
      if (!errorDiagnostic) throw new Error("Expected mod diagnostic");
      expect(errorDiagnostic.owner.path).toBe(path.join(modDir, "broken.ts"));
      expect(errorDiagnostic.error.message).toContain("Mod must export");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads mod-provided slash commands", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      const modPath = path.join(modDir, "commands.ts");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function(letta) {
          return letta.commands.register({
            id: "review-pr",
            description: "Review a GitHub PR",
            args: "<url-or-number>",
            order: 250,
            runWhenBusy: true,
            showInTranscript: false,
            run(ctx) {
              return { type: "prompt", content: "Review this PR: " + ctx.args };
            },
          });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(registry.commands["review-pr"]?.description).toBe(
        "Review a GitHub PR",
      );
      expect(registry.commands["review-pr"]?.args).toBe("<url-or-number>");
      expect(registry.commands["review-pr"]?.order).toBe(250);
      expect(registry.commands["review-pr"]?.runWhenBusy).toBe(true);
      expect(registry.commands["review-pr"]?.showInTranscript).toBe(false);
      await expect(
        Promise.resolve(
          registry.commands["review-pr"]?.run({
            ...createModContext(),
            agent: { id: "agent-1", name: "Amelia" },
            args: "123",
            argv: ["123"],
            command: "review-pr",
            conversation: {
              id: "conversation-1",
              fork: async () => {
                throw new Error("not implemented");
              },
              getHistory: async () => [],
              sendMessageStream: async () => (async function* () {})(),
              updateLlmConfig: async () => {},
            },
            cwd: "/tmp/project",
            model: {
              displayName: "Sonnet",
              id: "model-1",
              provider: "anthropic",
              reasoningEffort: null,
            },
            permissionMode: "standard",
            rawInput: "/review-pr 123",
          }),
        ),
      ).resolves.toEqual({ type: "prompt", content: "Review this PR: 123" });

      disposeLocalMods(registry);
      expect(registry.commands).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records command run diagnostics for removed scoped context helpers", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "legacy-command.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "legacy-command",
            description: "Old command",
            run(ctx) { return ctx.getContext(); },
          });
        }`,
      );

      const registry = await loadLocalMods(options);
      const command = registry.commands["legacy-command"];
      expect(command).toBeDefined();
      await expect(
        Promise.resolve(
          command
            ? runModCommandWithTimeout(command, {
                ...createModContext(),
                args: "",
                argv: [],
                command: "legacy-command",
                conversation: {
                  id: "conversation-1",
                  fork: async () => {
                    throw new Error("not implemented");
                  },
                  getHistory: async () => [],
                  sendMessageStream: async () => (async function* () {})(),
                  updateLlmConfig: async () => {},
                },
                rawInput: "/legacy-command",
              })
            : Promise.resolve({ type: "handled" as const }),
        ),
      ).rejects.toThrow("ctx.getContext is no longer available");
      const diagnostic = registry.diagnostics.at(-1);
      expect(diagnostic).toMatchObject({
        capability: { id: "legacy-command", kind: "command" },
        phase: "command.run",
      });
      expect(diagnostic?.error.message).toContain(
        "ctx.getContext is no longer available",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("passes the configured SDK client to mods", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "client.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "client-check",
            description: "Check client availability",
            async run() {
              return { type: "output", output: await letta.client.getMarker() };
            },
          });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      await expect(
        Promise.resolve(
          registry.commands["client-check"]?.run({
            ...createModContext(),
            agent: { id: "agent-1", name: "Amelia" },
            args: "",
            argv: [],
            command: "client-check",
            conversation: {
              id: "conversation-1",
              fork: async () => {
                throw new Error("not implemented");
              },
              getHistory: async () => [],
              sendMessageStream: async () => (async function* () {})(),
              updateLlmConfig: async () => {},
            },
            cwd: "/tmp/project",
            model: {
              displayName: "Sonnet",
              id: "model-1",
              provider: "anthropic",
              reasoningEffort: null,
            },
            permissionMode: "standard",
            rawInput: "/client-check",
          }),
        ),
      ).resolves.toEqual({ type: "output", output: "test-client" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets mods manage UI panels", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "panel.ts"),
        `export default function(letta) {
          const panel = letta.ui.openPanel({
            id: "btw",
            render: () => "answer",
          });
          return () => panel.close();
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      const panel = Object.values(registry.ui.panels)[0];
      expect(panel).toMatchObject({ id: "btw" });
      expect(panel?.render(renderCtx(80))).toBe("answer");

      disposeLocalMods(registry);
      expect(registry.ui.panels).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("scopes panel ids by mod path", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "a.ts"),
        `export default function(letta) {
          letta.ui.openPanel({ id: "status", render: () => "from a" });
        }`,
      );
      writeFileSync(
        path.join(modDir, "b.ts"),
        `export default function(letta) {
          letta.ui.openPanel({ id: "status", render: () => "from b" });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(
        Object.values(registry.ui.panels).map((panel) =>
          panel.render(renderCtx(80)),
        ),
      ).toEqual(["from a", "from b"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads legacy extensions with warnings and lets mods shadow them", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      const legacyExtensions = path.join(root, "legacy-extensions");
      const legacyPath = path.join(legacyExtensions, "review.ts");
      const modPath = path.join(modDir, "review.ts");
      mkdirSync(modDir, { recursive: true });
      mkdirSync(legacyExtensions, { recursive: true });
      writeFileSync(
        legacyPath,
        `export default function(letta) {
          letta.commands.register({
            id: "review",
            description: "Legacy review",
            run() { return { type: "output", output: "legacy" }; },
          });
        }`,
      );
      writeFileSync(
        modPath,
        `export default function(letta) {
          letta.commands.register({
            id: "review",
            description: "Mods review",
            run() { return { type: "output", output: "mods" }; },
          });
        }`,
      );

      const seenDiagnostics: ModDiagnostic[] = [];
      const registry = await loadLocalMods({
        ...options,
        legacyGlobalExtensionsDirectory: legacyExtensions,
        onDiagnostic: (diagnostic) => seenDiagnostics.push(diagnostic),
      });

      expect(registry.loadedPaths).toEqual([legacyPath, modPath]);
      expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([]);
      expect(registry.commands.review).toMatchObject({
        description: "Mods review",
        owner: { path: modPath, scope: "global" },
      });
      expect(registry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error: expect.objectContaining({
              message: `Loaded legacy extension from ${legacyPath}. Move it to ${modPath}.`,
            }),
            owner: expect.objectContaining({
              path: legacyPath,
              scope: "legacy_global",
            }),
            phase: "legacy_extension",
            severity: "warning",
          }),
        ]),
      );
      expect(seenDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "legacy_extension",
          }),
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects mod command id collisions and diagnoses built-in overrides", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "a.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "dupe",
            description: "First command",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(modDir, "b.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "dupe",
            description: "Second command",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(modDir, "c.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "reload",
            description: "Built-in conflict",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(modDir, "d.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "/bad",
            description: "Invalid id",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(Object.keys(registry.commands)).toEqual(["dupe", "reload"]);
      expect(registry.commands.reload?.description).toBe("Built-in conflict");
      const errorDiagnostics = getModErrorDiagnostics(registry.diagnostics);
      expect(errorDiagnostics.map((entry) => entry.owner.path).sort()).toEqual([
        path.join(modDir, "b.ts"),
        path.join(modDir, "d.ts"),
      ]);
      expect(errorDiagnostics.map((entry) => entry.error.message)).toEqual([
        expect.stringContaining("already registered"),
        expect.stringContaining("must not start"),
      ]);
      expect(registry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: { id: "reload", kind: "command" },
            error: expect.objectContaining({
              message: expect.stringContaining("overrides a built-in command"),
            }),
            owner: expect.objectContaining({
              path: path.join(modDir, "c.ts"),
            }),
            phase: "command_override",
          }),
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects mod tool names that collide with built-in tools", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "tool.ts"),
        `export default function(letta) {
          letta.tools.register({
            name: "Read",
            description: "Built-in conflict",
            run() { return "nope"; },
          });
        }`,
      );

      const registry = await loadLocalMods(options);

      expect(registry.tools).toEqual({});
      const errorDiagnostics = getModErrorDiagnostics(registry.diagnostics);
      expect(errorDiagnostics).toHaveLength(1);
      expect(errorDiagnostics[0]?.error.message).toContain("built-in tool");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runs mod disposers", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const modDir = options.globalModsDirectory;
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "status.ts"),
        `export default function(letta) {
          const panel = letta.ui.openPanel({ id: "mode", render: () => "fast" });
          return () => panel.close();
        }`,
      );

      const registry = await loadLocalMods(options);
      expect(registry.disposers).toHaveLength(1);
      expect(Object.keys(registry.ui.panels)).toHaveLength(1);

      disposeLocalMods(registry);

      expect(registry.disposers).toEqual([]);
      expect(registry.ui.panels).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
