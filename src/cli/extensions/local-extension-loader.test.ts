import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStatuslineRenderContext } from "@/cli/display/statusline/context";
import type { StatuslineRenderContext } from "@/cli/display/statusline/types";
import {
  disposeLocalExtensions,
  evaluateLocalExtensionStatuses,
  loadLocalExtensions,
  resolveLocalExtensionSources,
} from "@/cli/extensions/local-extension-loader";
import { buildStatusLinePayload } from "@/cli/helpers/status-line-payload";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extensions-"));
}

function createStatuslineContext(): StatuslineRenderContext {
  return buildStatuslineRenderContext({
    payload: buildStatusLinePayload({
      agentName: "Letta Code",
      currentDirectory: "/tmp/project",
      modelDisplayName: "Sonnet 4.6",
      projectDirectory: "/tmp/project",
      toolset: "default",
    }),
    statuses: { mode: "fast" },
    ui: {
      currentModelProvider: "anthropic",
      goalStatusText: null,
      hasTemporaryModelOverride: false,
      isByokProvider: false,
      isLocalBackend: true,
      isOpenAICodexProvider: false,
      rightColumnWidth: 80,
    },
  });
}

function createLoadOptions(root: string) {
  return {
    cacheDirectory: path.join(root, "extension-cache"),
    getContext: createStatuslineContext,
    globalExtensionsDirectory: path.join(root, "global-extensions"),
  };
}

describe("local extension loader", () => {
  test("discovers global extension source", () => {
    const root = createTempDir();
    try {
      const { globalExtensionsDirectory: globalExtensions } =
        createLoadOptions(root);
      mkdirSync(globalExtensions, { recursive: true });
      writeFileSync(
        path.join(globalExtensions, "a.ts"),
        "export default () => {};",
      );
      writeFileSync(
        path.join(globalExtensions, "b.tsx"),
        "export default () => {};",
      );

      expect(
        resolveLocalExtensionSources({
          globalExtensionsDirectory: globalExtensions,
        }),
      ).toEqual([
        {
          files: [
            path.join(globalExtensions, "a.ts"),
            path.join(globalExtensions, "b.tsx"),
          ],
          root: globalExtensions,
          scope: "global",
          trusted: true,
        },
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads extensions that register statuses and statusline renderers", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      const extensionPath = path.join(extensionDir, "statusline.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          letta.ui.setStatus("mode", "fast");
          letta.ui.setStatus("agent", (ctx) => ctx.agent.name);
          letta.ui.setStatuslineRenderer((ctx) => "first:" + ctx.statuses.mode);
        }`,
      );

      const firstRegistry = await loadLocalExtensions(options);
      expect(firstRegistry.errors).toEqual([]);
      expect(firstRegistry.loadedPaths).toEqual([extensionPath]);
      expect(
        evaluateLocalExtensionStatuses(
          firstRegistry,
          createStatuslineContext(),
        ),
      ).toEqual({ agent: "Letta Code", mode: "fast" });
      expect(
        firstRegistry.ui.statuslineRenderer?.render({
          ...createStatuslineContext(),
          statuses: evaluateLocalExtensionStatuses(
            firstRegistry,
            createStatuslineContext(),
          ),
        }),
      ).toBe("first:fast");

      writeFileSync(
        extensionPath,
        `export default function(letta) {
          letta.ui.setStatus("mode", "slow");
          letta.ui.setStatuslineRenderer((ctx) => "second:" + ctx.statuses.mode);
        }`,
      );

      const secondRegistry = await loadLocalExtensions(options);
      expect(secondRegistry.errors).toEqual([]);
      expect(
        evaluateLocalExtensionStatuses(
          secondRegistry,
          createStatuslineContext(),
        ),
      ).toEqual({ mode: "slow" });
      expect(
        secondRegistry.ui.statuslineRenderer?.render({
          ...createStatuslineContext(),
          statuses: evaluateLocalExtensionStatuses(
            secondRegistry,
            createStatuslineContext(),
          ),
        }),
      ).toBe("second:slow");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("transpiles TypeScript and TSX extensions to importable mjs cache files", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      const extensionPath = path.join(extensionDir, "statusline.tsx");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta: any) {
          const Label = letta.getContext().components.Text;
          letta.ui.setStatuslineRenderer((ctx: any) => <Label>{ctx.agent.name}</Label>);
        }`,
      );

      const registry = await loadLocalExtensions(options);

      expect(registry.errors).toEqual([]);
      expect(registry.loadedPaths).toEqual([extensionPath]);
      const cacheFiles = readdirSync(options.cacheDirectory).filter((entry) =>
        entry.startsWith(".letta-extension-statusline-"),
      );
      expect(cacheFiles).toHaveLength(1);
      expect(cacheFiles[0]?.endsWith(".mjs")).toBe(true);
      const output = registry.ui.statuslineRenderer?.render(
        createStatuslineContext(),
      );
      expect(output).toMatchObject({ props: { children: "Letta Code" } });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("captures extension load errors without blocking other extensions", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "broken.ts"),
        "export const nope = 1;",
      );
      writeFileSync(
        path.join(extensionDir, "working.ts"),
        `export default function(letta) {
          letta.ui.setStatus("ok", "true");
        }`,
      );

      const registry = await loadLocalExtensions(options);

      expect(registry.loadedPaths).toEqual([
        path.join(extensionDir, "working.ts"),
      ]);
      expect(
        evaluateLocalExtensionStatuses(registry, createStatuslineContext()),
      ).toEqual({ ok: "true" });
      expect(registry.errors).toHaveLength(1);
      expect(registry.errors[0]?.path).toBe(
        path.join(extensionDir, "broken.ts"),
      );
      expect(registry.errors[0]?.error.message).toContain(
        "Extension must export",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads extension-provided slash commands", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      const extensionPath = path.join(extensionDir, "commands.ts");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        extensionPath,
        `export default function(letta) {
          return letta.commands.register({
            id: "review-pr",
            description: "Review a GitHub PR",
            args: "<url-or-number>",
            order: 250,
            run(ctx) {
              return { type: "prompt", content: "Review this PR: " + ctx.args };
            },
          });
        }`,
      );

      const registry = await loadLocalExtensions(options);

      expect(registry.errors).toEqual([]);
      expect(registry.commands["review-pr"]?.description).toBe(
        "Review a GitHub PR",
      );
      expect(registry.commands["review-pr"]?.args).toBe("<url-or-number>");
      expect(registry.commands["review-pr"]?.order).toBe(250);
      await expect(
        Promise.resolve(
          registry.commands["review-pr"]?.run({
            agent: { id: "agent-1", name: "Amelia" },
            args: "123",
            argv: ["123"],
            command: "review-pr",
            conversation: { id: "conversation-1" },
            cwd: "/tmp/project",
            getContext: createStatuslineContext,
            model: { id: "model-1", displayName: "Sonnet" },
            permissionMode: "standard",
            rawInput: "/review-pr 123",
          }),
        ),
      ).resolves.toEqual({ type: "prompt", content: "Review this PR: 123" });

      disposeLocalExtensions(registry);
      expect(registry.commands).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects extension command id collisions", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "a.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "dupe",
            description: "First command",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(extensionDir, "b.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "dupe",
            description: "Second command",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(extensionDir, "c.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "reload",
            description: "Built-in conflict",
            run() { return { type: "handled" }; },
          });
        }`,
      );
      writeFileSync(
        path.join(extensionDir, "d.ts"),
        `export default function(letta) {
          letta.commands.register({
            id: "/bad",
            description: "Invalid id",
            run() { return { type: "handled" }; },
          });
        }`,
      );

      const registry = await loadLocalExtensions(options);

      expect(Object.keys(registry.commands)).toEqual(["dupe"]);
      expect(registry.errors.map((entry) => entry.path).sort()).toEqual([
        path.join(extensionDir, "b.ts"),
        path.join(extensionDir, "c.ts"),
        path.join(extensionDir, "d.ts"),
      ]);
      expect(registry.errors.map((entry) => entry.error.message)).toEqual([
        expect.stringContaining("already registered"),
        expect.stringContaining("built-in command"),
        expect.stringContaining("must not start"),
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("runs extension disposers", async () => {
    const root = createTempDir();
    try {
      const options = createLoadOptions(root);
      const extensionDir = options.globalExtensionsDirectory;
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "status.ts"),
        `export default function(letta) {
          letta.ui.setStatus("mode", "fast");
          letta.ui.setStatuslineRenderer(() => "statusline");
          return () => letta.ui.clearStatus("mode");
        }`,
      );

      const registry = await loadLocalExtensions(options);
      expect(registry.disposers).toHaveLength(1);
      expect(
        evaluateLocalExtensionStatuses(registry, createStatuslineContext()),
      ).toEqual({ mode: "fast" });
      expect(registry.ui.statuslineRenderer).not.toBeNull();

      disposeLocalExtensions(registry);

      expect(registry.disposers).toEqual([]);
      expect(
        evaluateLocalExtensionStatuses(registry, createStatuslineContext()),
      ).toEqual({});
      expect(registry.ui.statuslineRenderer).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
