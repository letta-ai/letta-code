import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Letta from "@letta-ai/letta-client";
import * as ts from "typescript";
import { commands as builtinCommands } from "@/cli/commands/registry";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";
import type {
  ExtensionCommand,
  ExtensionCommandRegistration,
  ExtensionContext,
  ExtensionPanel,
  ExtensionPanelContent,
  ExtensionPanelHandle,
  ExtensionPanelOptions,
  ExtensionPanelUpdate,
} from "@/cli/extensions/types";

export const GLOBAL_EXTENSIONS_DIRECTORY = path.join(
  homedir(),
  ".letta",
  "extensions",
);
export const EXTENSION_CACHE_DIRECTORY = path.join(
  homedir(),
  ".letta",
  "extension-cache",
);

const EXTENSION_FILE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const TYPESCRIPT_EXTENSION_FILE_EXTENSIONS = new Set([".ts", ".tsx"]);
const requireFromRuntime = createRequire(import.meta.url);

export type StatuslineRenderFunction = (
  context: StatuslineRenderContext,
) => StatuslineRendererOutput;

export type ExtensionStatusValue =
  | string
  | null
  | ((context: ExtensionContext) => string | null);

export type LettaExtensionDisposer = () => void;

export type LettaExtensionFactory = (
  letta: LettaExtensionApi,
) =>
  | undefined
  | LettaExtensionDisposer
  | Promise<undefined | LettaExtensionDisposer>;

export interface LettaExtensionApi {
  client: Letta;
  getClient: () => Promise<Letta>;
  getContext: () => ExtensionContext;
  commands: {
    register: (command: ExtensionCommandRegistration) => LettaExtensionDisposer;
    unregister: (id: string) => void;
  };
  ui: {
    clearPanel: (id: string) => void;
    clearStatus: (key: string) => void;
    openPanel: (panel: ExtensionPanelOptions) => ExtensionPanelHandle;
    setStatus: (key: string, value: ExtensionStatusValue | undefined) => void;
    setStatuslineRenderer: (
      renderer: StatuslineRenderer | StatuslineRenderFunction,
    ) => void;
  };
}

export interface LocalExtensionDisposer {
  dispose: LettaExtensionDisposer;
  path: string;
}

export interface LocalExtensionLoadError {
  error: Error;
  path: string;
}

export interface LocalExtensionUiRegistry {
  panels: Record<string, ExtensionPanel>;
  statuslineRenderer: StatuslineRenderer | null;
  statusValues: Record<string, ExtensionStatusValue>;
}

export interface LocalExtensionRegistry {
  commands: Record<string, ExtensionCommand>;
  disposers: LocalExtensionDisposer[];
  errors: LocalExtensionLoadError[];
  loadedPaths: string[];
  sources: LocalExtensionSource[];
  ui: LocalExtensionUiRegistry;
}

export interface LocalExtensionSource {
  files: string[];
  root: string;
  scope: "global" | "project";
  trusted: boolean;
}

interface LocalExtensionModule {
  activate?: unknown;
  default?: unknown;
}

export interface ResolveLocalExtensionSourcesOptions {
  cacheDirectory?: string;
  globalExtensionsDirectory?: string;
}

export interface LoadLocalExtensionsOptions
  extends ResolveLocalExtensionSourcesOptions {
  getContext?: () => ExtensionContext;
  getClient: () => Promise<Letta>;
  onChange?: () => void;
  reservedCommandIds?: Iterable<string>;
}

function listExtensionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.startsWith(".")) return false;
      return EXTENSION_FILE_EXTENSIONS.has(path.extname(entry.name));
    })
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function resolveLocalExtensionSources(
  options: ResolveLocalExtensionSourcesOptions = {},
): LocalExtensionSource[] {
  const globalExtensionsDirectory =
    options.globalExtensionsDirectory ?? GLOBAL_EXTENSIONS_DIRECTORY;

  return [
    {
      files: listExtensionFiles(globalExtensionsDirectory),
      root: globalExtensionsDirectory,
      scope: "global",
      trusted: true,
    },
  ];
}

function getRuntimePackageDirectory(packageName: string): string {
  return path.dirname(
    requireFromRuntime.resolve(path.join(packageName, "package.json")),
  );
}

function ensureRuntimeDependencySymlink(
  cacheDirectory: string,
  packageName: string,
): void {
  const nodeModulesDirectory = path.join(cacheDirectory, "node_modules");
  const linkPath = path.join(nodeModulesDirectory, packageName);
  if (existsSync(linkPath)) return;

  mkdirSync(nodeModulesDirectory, { recursive: true });
  symlinkSync(
    getRuntimePackageDirectory(packageName),
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function ensureExtensionCache(cacheDirectory: string): void {
  mkdirSync(cacheDirectory, { recursive: true });
  ensureRuntimeDependencySymlink(cacheDirectory, "react");
}

function formatTranspileDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start == null) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}

function transpileTypeScriptExtension(
  extensionPath: string,
  source: string,
): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: extensionPath,
    reportDiagnostics: true,
  });

  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(errors.map(formatTranspileDiagnostic).join("\n"));
  }

  return result.outputText;
}

function prepareExtensionForImport(
  extensionPath: string,
  source: string,
): string {
  const extension = path.extname(extensionPath);
  if (TYPESCRIPT_EXTENSION_FILE_EXTENSIONS.has(extension)) {
    return transpileTypeScriptExtension(extensionPath, source);
  }

  return source;
}

function createImportableExtensionPath(
  extensionPath: string,
  cacheDirectory: string,
): string {
  ensureExtensionCache(cacheDirectory);

  const source = readFileSync(extensionPath, "utf8");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const extension = path.extname(extensionPath);
  const importableSource = prepareExtensionForImport(extensionPath, source);
  const baseName = path
    .basename(extensionPath, extension)
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const importPath = path.join(
    cacheDirectory,
    `.letta-extension-${baseName}-${hash}.mjs`,
  );

  if (!existsSync(importPath)) {
    writeFileSync(importPath, importableSource, "utf8");
  }

  try {
    for (const entry of readdirSync(cacheDirectory)) {
      if (
        entry.startsWith(`.letta-extension-${baseName}-`) &&
        entry !== path.basename(importPath)
      ) {
        unlinkSync(path.join(cacheDirectory, entry));
      }
    }
  } catch {
    // Best-effort cache cleanup only.
  }

  return importPath;
}

function toStatuslineRenderer(
  renderer: StatuslineRenderer | StatuslineRenderFunction,
  extensionPath: string,
): StatuslineRenderer {
  if (typeof renderer === "function") {
    return {
      id: `local:${extensionPath}`,
      label: path.basename(extensionPath),
      description: extensionPath,
      render: renderer,
    };
  }

  return renderer;
}

function createLazyClient(getClient: () => Promise<Letta>): Letta {
  const createProxy = (path: PropertyKey[] = []): unknown =>
    new Proxy(function lazyLettaClientProxy() {}, {
      apply(_target, _thisArg, args) {
        return getClient().then((client) => {
          let owner: unknown = client;
          let value: unknown = client;
          for (const property of path) {
            owner = value;
            value = (value as Record<PropertyKey, unknown>)[property];
          }
          if (typeof value !== "function") {
            throw new TypeError(
              `letta.client.${path.map(String).join(".")} is not callable`,
            );
          }
          return value.apply(owner, args);
        });
      },
      get(_target, property) {
        // Keep the proxy from being treated as a Promise when code does
        // `await letta.client` or Promise.resolve(letta.client).
        if (property === "then") return undefined;
        return createProxy([...path, property]);
      },
    });

  return createProxy() as Letta;
}

function stripSlash(command: string): string {
  return command.startsWith("/") ? command.slice(1) : command;
}

function getDefaultReservedCommandIds(): Set<string> {
  return new Set(Object.keys(builtinCommands).map(stripSlash));
}

function validateExtensionCommandId(id: string): void {
  if (id.startsWith("/")) {
    throw new Error("Extension command id must not start with '/'");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Extension command id must be a lowercase slug using letters, numbers, and hyphens",
    );
  }
}

function normalizeExtensionCommand(
  command: ExtensionCommandRegistration,
  extensionPath: string,
): ExtensionCommand {
  validateExtensionCommandId(command.id);
  if (!command.description.trim()) {
    throw new Error(
      `Extension command '${command.id}' must include a description`,
    );
  }
  if (typeof command.run !== "function") {
    throw new Error(`Extension command '${command.id}' must include run()`);
  }

  return {
    id: command.id,
    description: command.description,
    ...(command.args ? { args: command.args } : {}),
    order: command.order ?? 250,
    path: extensionPath,
    runWhenBusy: command.runWhenBusy === true,
    showInTranscript: command.showInTranscript !== false,
    run: command.run,
  };
}

function validateExtensionPanelId(id: string): void {
  if (!id.trim()) {
    throw new Error("Extension panel id must not be empty");
  }
}

function getExtensionPanelKey(extensionPath: string, id: string): string {
  return JSON.stringify([extensionPath, id]);
}

function normalizePanelContent(
  content: ExtensionPanelContent | undefined,
): string[] {
  if (content == null) return [];
  return Array.isArray(content)
    ? content.map(String)
    : String(content).split("\n");
}

function upsertExtensionPanel(
  registry: LocalExtensionRegistry,
  extensionPath: string,
  id: string,
  update: ExtensionPanelUpdate,
): void {
  validateExtensionPanelId(id);
  const panelKey = getExtensionPanelKey(extensionPath, id);
  const existing = registry.ui.panels[panelKey];
  registry.ui.panels[panelKey] = {
    content:
      update.content === undefined
        ? (existing?.content ?? [])
        : normalizePanelContent(update.content),
    id,
    order: update.order ?? existing?.order ?? 100,
    path: extensionPath,
    updatedAt: Date.now(),
  };
}

function createLettaExtensionApi(
  registry: LocalExtensionRegistry,
  extensionPath: string,
  getClient: () => Promise<Letta>,
  getContext: () => ExtensionContext,
  onChange: () => void,
  reservedCommandIds: Set<string>,
): LettaExtensionApi {
  const unregisterCommand = (id: string) => {
    validateExtensionCommandId(id);
    const existing = registry.commands[id];
    if (existing?.path === extensionPath) {
      delete registry.commands[id];
      onChange();
    }
  };

  const clearPanel = (id: string) => {
    validateExtensionPanelId(id);
    const panelKey = getExtensionPanelKey(extensionPath, id);
    const existing = registry.ui.panels[panelKey];
    if (existing?.path === extensionPath) {
      delete registry.ui.panels[panelKey];
      onChange();
    }
  };

  return {
    client: createLazyClient(getClient),
    getClient,
    getContext,
    commands: {
      register(command) {
        const normalized = normalizeExtensionCommand(command, extensionPath);
        if (reservedCommandIds.has(normalized.id)) {
          throw new Error(
            `Extension command '${normalized.id}' conflicts with a built-in command`,
          );
        }

        const existing = registry.commands[normalized.id];
        if (existing && !command.override) {
          throw new Error(
            `Extension command '${normalized.id}' is already registered by ${existing.path}`,
          );
        }

        registry.commands[normalized.id] = normalized;
        onChange();

        return () => unregisterCommand(normalized.id);
      },
      unregister: unregisterCommand,
    },
    ui: {
      clearPanel,
      clearStatus(key) {
        delete registry.ui.statusValues[key];
        onChange();
      },
      openPanel(panel) {
        upsertExtensionPanel(registry, extensionPath, panel.id, panel);
        onChange();
        return {
          close() {
            clearPanel(panel.id);
          },
          update(update) {
            upsertExtensionPanel(registry, extensionPath, panel.id, update);
            onChange();
          },
        };
      },
      setStatus(key, value) {
        if (value == null) {
          delete registry.ui.statusValues[key];
          onChange();
          return;
        }
        registry.ui.statusValues[key] = value;
        onChange();
      },
      setStatuslineRenderer(renderer) {
        registry.ui.statuslineRenderer = toStatuslineRenderer(
          renderer,
          extensionPath,
        );
        onChange();
      },
    },
  };
}

function getExtensionFactory(module: LocalExtensionModule): unknown {
  return typeof module.default === "function"
    ? module.default
    : module.activate;
}

export async function loadLocalExtensions(
  options: LoadLocalExtensionsOptions,
): Promise<LocalExtensionRegistry> {
  const cacheDirectory = options.cacheDirectory ?? EXTENSION_CACHE_DIRECTORY;
  let clientPromise: Promise<Letta> | null = null;
  const getConfiguredClient = () => {
    clientPromise ??= options.getClient();
    return clientPromise;
  };
  const getContext =
    options.getContext ??
    (() => {
      throw new Error("Extension context is not available yet");
    });
  const onChange = options.onChange ?? (() => {});
  const sources = resolveLocalExtensionSources(options);
  const reservedCommandIds = new Set([
    ...getDefaultReservedCommandIds(),
    ...(options.reservedCommandIds ?? []),
  ]);
  const registry: LocalExtensionRegistry = {
    commands: {},
    disposers: [],
    errors: [],
    loadedPaths: [],
    sources,
    ui: {
      panels: {},
      statuslineRenderer: null,
      statusValues: {},
    },
  };

  for (const extensionPath of sources.flatMap((source) => source.files)) {
    try {
      const mtimeMs = statSync(extensionPath).mtimeMs;
      const importPath = createImportableExtensionPath(
        extensionPath,
        cacheDirectory,
      );
      const module = (await import(
        `${pathToFileURL(importPath).href}?extension=${mtimeMs}`
      )) as LocalExtensionModule;
      const factory = getExtensionFactory(module);

      if (typeof factory !== "function") {
        throw new Error(
          "Extension must export a default function or activate() function",
        );
      }

      const dispose = await (factory as LettaExtensionFactory)(
        createLettaExtensionApi(
          registry,
          extensionPath,
          getConfiguredClient,
          getContext,
          onChange,
          reservedCommandIds,
        ),
      );
      if (typeof dispose === "function") {
        registry.disposers.push({ dispose, path: extensionPath });
      }
      registry.loadedPaths.push(extensionPath);
    } catch (error) {
      registry.errors.push({
        error: error instanceof Error ? error : new Error(String(error)),
        path: extensionPath,
      });
    }
  }

  return registry;
}

export function evaluateLocalExtensionStatuses(
  registry: LocalExtensionRegistry | null,
  context: ExtensionContext,
): Record<string, string> {
  if (!registry) return {};

  const statuses: Record<string, string> = {};
  for (const [key, value] of Object.entries(registry.ui.statusValues)) {
    try {
      const nextValue = typeof value === "function" ? value(context) : value;
      if (nextValue != null) {
        statuses[key] = nextValue;
      }
    } catch {
      // Status providers run during render; failed providers are skipped so the
      // extension cannot crash the TUI.
    }
  }

  return statuses;
}

export function disposeLocalExtensions(registry: LocalExtensionRegistry): void {
  const disposers = [...registry.disposers].reverse();
  registry.disposers = [];

  for (const { dispose, path: extensionPath } of disposers) {
    try {
      dispose();
    } catch (error) {
      registry.errors.push({
        error: error instanceof Error ? error : new Error(String(error)),
        path: extensionPath,
      });
    }
  }

  registry.commands = {};
  registry.ui.panels = {};
  registry.ui.statusValues = {};
  registry.ui.statuslineRenderer = null;
}
