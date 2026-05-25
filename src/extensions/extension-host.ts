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
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";
import type {
  ExtensionCommand,
  ExtensionCommandRegistration,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionOwner,
  ExtensionPanel,
  ExtensionPanelContent,
  ExtensionPanelHandle,
  ExtensionPanelOptions,
  ExtensionPanelUpdate,
} from "@/extensions/types";

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
  signal: AbortSignal;
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
  abortController?: AbortController;
  dispose: LettaExtensionDisposer;
  owner?: ExtensionOwner;
  path: string;
}

export interface LocalExtensionLoadError {
  error: Error;
  owner?: ExtensionOwner;
  path: string;
  phase?: ExtensionDiagnostic["phase"];
}

export interface LocalExtensionUiRegistry {
  panels: Record<string, ExtensionPanel>;
  statuslineRenderer: StatuslineRenderer | null;
  statuslineRendererOwner?: ExtensionOwner;
  statusOwners: Record<string, ExtensionOwner>;
  statusValues: Record<string, ExtensionStatusValue>;
}

export interface LocalExtensionRegistry {
  commands: Record<string, ExtensionCommand>;
  diagnostics: ExtensionDiagnostic[];
  disposers: LocalExtensionDisposer[];
  errors: LocalExtensionLoadError[];
  generation: number;
  loadedPaths: string[];
  ownerAbortControllers: Record<string, AbortController>;
  owners: Record<string, ExtensionOwner>;
  sources: LocalExtensionSource[];
  ui: LocalExtensionUiRegistry;
}

export interface LocalExtensionSource {
  files: string[];
  root: string;
  scope: "global" | "project" | "bundled";
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
  generation?: number;
  onChange?: () => void;
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  reservedCommandIds?: Iterable<string>;
}

export interface ExtensionHost {
  dispose: () => void;
  getSnapshot: () => LocalExtensionRegistry;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export interface CreateExtensionHostOptions
  extends ResolveLocalExtensionSourcesOptions {
  getContext?: () => ExtensionContext;
  getClient: () => Promise<Letta>;
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

function createEmptyExtensionRegistry(
  sources: LocalExtensionSource[],
  generation: number,
): LocalExtensionRegistry {
  return {
    commands: {},
    diagnostics: [],
    disposers: [],
    errors: [],
    generation,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    sources,
    ui: {
      panels: {},
      statuslineRenderer: null,
      statusOwners: {},
      statusValues: {},
    },
  };
}

function createExtensionOwner(
  extensionPath: string,
  source: LocalExtensionSource,
  generation: number,
): ExtensionOwner {
  return {
    id: `${source.scope}:${extensionPath}`,
    path: extensionPath,
    scope: source.scope,
    generation,
  };
}

function isOwnerLive(
  registry: LocalExtensionRegistry,
  owner: ExtensionOwner,
): boolean {
  return registry.owners[owner.id]?.generation === owner.generation;
}

function recordExtensionDiagnostic(
  registry: LocalExtensionRegistry,
  diagnostic: Omit<ExtensionDiagnostic, "timestamp">,
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): void {
  const completeDiagnostic: ExtensionDiagnostic = {
    ...diagnostic,
    timestamp: Date.now(),
  };
  registry.diagnostics.push(completeDiagnostic);
  if (completeDiagnostic.phase !== "status.evaluate") {
    registry.errors.push({
      error: completeDiagnostic.error,
      ...(completeDiagnostic.owner ? { owner: completeDiagnostic.owner } : {}),
      path: completeDiagnostic.path ?? completeDiagnostic.owner?.path ?? "",
      phase: completeDiagnostic.phase,
    });
  }
  onDiagnostic?.(completeDiagnostic);
}

function recordStaleHandleUse(
  registry: LocalExtensionRegistry,
  owner: ExtensionOwner,
  capability: ExtensionDiagnostic["capability"],
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): void {
  recordExtensionDiagnostic(
    registry,
    {
      capability,
      error: new Error(
        `Ignored stale extension handle for ${capability?.kind ?? "capability"}${capability?.id ? ` '${capability.id}'` : ""}`,
      ),
      owner,
      path: owner.path,
      phase: "stale_handle",
    },
    onDiagnostic,
  );
}

function snapshotRegistryForReaders(
  registry: LocalExtensionRegistry,
): LocalExtensionRegistry {
  return {
    ...registry,
    commands: { ...registry.commands },
    diagnostics: [...registry.diagnostics],
    disposers: [...registry.disposers],
    errors: [...registry.errors],
    loadedPaths: [...registry.loadedPaths],
    ownerAbortControllers: { ...registry.ownerAbortControllers },
    owners: { ...registry.owners },
    sources: registry.sources.map((source) => ({
      ...source,
      files: [...source.files],
    })),
    ui: {
      ...registry.ui,
      panels: { ...registry.ui.panels },
      statusOwners: { ...registry.ui.statusOwners },
      statusValues: { ...registry.ui.statusValues },
    },
  };
}

function removeOwnerCapabilities(
  registry: LocalExtensionRegistry,
  owner: ExtensionOwner,
): void {
  for (const [id, command] of Object.entries(registry.commands)) {
    if (command.owner?.id === owner.id) {
      delete registry.commands[id];
    }
  }

  for (const [id, panel] of Object.entries(registry.ui.panels)) {
    if (panel.owner?.id === owner.id) {
      delete registry.ui.panels[id];
    }
  }

  for (const [key, statusOwner] of Object.entries(registry.ui.statusOwners)) {
    if (statusOwner.id === owner.id) {
      delete registry.ui.statusOwners[key];
      delete registry.ui.statusValues[key];
    }
  }

  if (registry.ui.statuslineRendererOwner?.id === owner.id) {
    registry.ui.statuslineRenderer = null;
    delete registry.ui.statuslineRendererOwner;
  }

  delete registry.owners[owner.id];
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
  owner: ExtensionOwner,
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
    owner,
    order: command.order ?? 250,
    path: owner.path,
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
  owner: ExtensionOwner,
  id: string,
  update: ExtensionPanelUpdate,
): void {
  validateExtensionPanelId(id);
  const panelKey = getExtensionPanelKey(owner.id, id);
  const existing = registry.ui.panels[panelKey];
  registry.ui.panels[panelKey] = {
    content:
      update.content === undefined
        ? (existing?.content ?? [])
        : normalizePanelContent(update.content),
    id,
    owner,
    order: update.order ?? existing?.order ?? 100,
    path: owner.path,
    updatedAt: Date.now(),
  };
}

function createLettaExtensionApi(
  registry: LocalExtensionRegistry,
  owner: ExtensionOwner,
  getClient: () => Promise<Letta>,
  getContext: () => ExtensionContext,
  onChange: () => void,
  onDiagnostic: ((diagnostic: ExtensionDiagnostic) => void) | undefined,
  reservedCommandIds: Set<string>,
  signal: AbortSignal,
): LettaExtensionApi {
  const isLive = () => isOwnerLive(registry, owner);
  const guardLive = (
    capability: ExtensionDiagnostic["capability"],
  ): boolean => {
    if (isLive()) return true;
    recordStaleHandleUse(registry, owner, capability, onDiagnostic);
    return false;
  };

  const unregisterCommand = (id: string) => {
    validateExtensionCommandId(id);
    if (!guardLive({ id, kind: "command" })) return;
    const existing = registry.commands[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.commands[id];
      onChange();
    }
  };

  const clearPanel = (id: string) => {
    validateExtensionPanelId(id);
    if (!guardLive({ id, kind: "panel" })) return;
    const panelKey = getExtensionPanelKey(owner.id, id);
    const existing = registry.ui.panels[panelKey];
    if (existing?.owner?.id === owner.id) {
      delete registry.ui.panels[panelKey];
      onChange();
    }
  };

  return {
    client: createLazyClient(getClient),
    getClient,
    getContext,
    signal,
    commands: {
      register(command) {
        if (!guardLive({ id: command.id, kind: "command" })) {
          return () => undefined;
        }

        const normalized = normalizeExtensionCommand(command, owner);
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
        if (!guardLive({ id: key, kind: "status" })) return;
        delete registry.ui.statusValues[key];
        delete registry.ui.statusOwners[key];
        onChange();
      },
      openPanel(panel) {
        if (!guardLive({ id: panel.id, kind: "panel" })) {
          return {
            close() {},
            update() {},
          };
        }

        upsertExtensionPanel(registry, owner, panel.id, panel);
        onChange();
        return {
          close() {
            clearPanel(panel.id);
          },
          update(update) {
            if (!guardLive({ id: panel.id, kind: "panel" })) return;
            upsertExtensionPanel(registry, owner, panel.id, update);
            onChange();
          },
        };
      },
      setStatus(key, value) {
        if (!guardLive({ id: key, kind: "status" })) return;
        if (value == null) {
          delete registry.ui.statusValues[key];
          delete registry.ui.statusOwners[key];
          onChange();
          return;
        }
        registry.ui.statusValues[key] = value;
        registry.ui.statusOwners[key] = owner;
        onChange();
      },
      setStatuslineRenderer(renderer) {
        if (!guardLive({ id: owner.id, kind: "statusline" })) return;
        registry.ui.statuslineRenderer = toStatuslineRenderer(
          renderer,
          owner.path,
        );
        registry.ui.statuslineRendererOwner = owner;
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
  const generation = options.generation ?? 1;
  const reservedCommandIds = new Set([...(options.reservedCommandIds ?? [])]);
  const registry = createEmptyExtensionRegistry(sources, generation);

  for (const source of sources) {
    for (const extensionPath of source.files) {
      const owner = createExtensionOwner(extensionPath, source, generation);
      const abortController = new AbortController();
      let failurePhase: ExtensionDiagnostic["phase"] = "import";
      registry.ownerAbortControllers[owner.id] = abortController;
      registry.owners[owner.id] = owner;

      try {
        const mtimeMs = statSync(extensionPath).mtimeMs;
        failurePhase = TYPESCRIPT_EXTENSION_FILE_EXTENSIONS.has(
          path.extname(extensionPath),
        )
          ? "transpile"
          : "import";
        const importPath = createImportableExtensionPath(
          extensionPath,
          cacheDirectory,
        );
        failurePhase = "import";
        const module = (await import(
          `${pathToFileURL(importPath).href}?extension=${mtimeMs}`
        )) as LocalExtensionModule;
        const factory = getExtensionFactory(module);
        failurePhase = "activate";

        if (typeof factory !== "function") {
          throw new Error(
            "Extension must export a default function or activate() function",
          );
        }

        const dispose = await (factory as LettaExtensionFactory)(
          createLettaExtensionApi(
            registry,
            owner,
            getConfiguredClient,
            getContext,
            onChange,
            options.onDiagnostic,
            reservedCommandIds,
            abortController.signal,
          ),
        );
        if (typeof dispose === "function") {
          registry.disposers.push({
            abortController,
            dispose,
            owner,
            path: extensionPath,
          });
        }
        registry.loadedPaths.push(extensionPath);
      } catch (error) {
        removeOwnerCapabilities(registry, owner);
        abortController.abort("extension activation failed");
        delete registry.ownerAbortControllers[owner.id];
        recordExtensionDiagnostic(
          registry,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            owner,
            path: extensionPath,
            phase: failurePhase,
          },
          options.onDiagnostic,
        );
      }
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
  for (const abortController of Object.values(registry.ownerAbortControllers)) {
    abortController.abort("extension disposed");
  }

  const disposers = [...registry.disposers].reverse();
  registry.disposers = [];

  for (const { dispose, owner, path: extensionPath } of disposers) {
    try {
      dispose();
    } catch (error) {
      recordExtensionDiagnostic(registry, {
        error: error instanceof Error ? error : new Error(String(error)),
        ...(owner ? { owner } : {}),
        path: extensionPath,
        phase: "dispose",
      });
    }
  }

  registry.commands = {};
  registry.ownerAbortControllers = {};
  registry.owners = {};
  registry.ui.panels = {};
  registry.ui.statusOwners = {};
  registry.ui.statusValues = {};
  registry.ui.statuslineRenderer = null;
  delete registry.ui.statuslineRendererOwner;
}

export function createExtensionHost(
  options: CreateExtensionHostOptions,
): ExtensionHost {
  let generation = 0;
  let disposed = false;
  let activeRegistry = createEmptyExtensionRegistry(
    resolveLocalExtensionSources(options),
    generation,
  );
  let snapshot = snapshotRegistryForReaders(activeRegistry);
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = snapshotRegistryForReaders(activeRegistry);
    for (const listener of listeners) {
      listener();
    }
  };

  const reload = async () => {
    if (disposed) return;

    disposeLocalExtensions(activeRegistry);
    generation += 1;
    const loadGeneration = generation;
    activeRegistry = createEmptyExtensionRegistry(
      resolveLocalExtensionSources(options),
      loadGeneration,
    );
    publish();

    let loadingRegistry: LocalExtensionRegistry | null = null;
    const nextRegistry = await loadLocalExtensions({
      ...options,
      generation: loadGeneration,
      onChange: () => {
        if (!disposed && loadingRegistry && loadGeneration === generation) {
          activeRegistry = loadingRegistry;
          publish();
        }
      },
      onDiagnostic: (diagnostic) => {
        if (disposed) return;

        if (loadingRegistry && loadGeneration === generation) {
          activeRegistry = loadingRegistry;
          publish();
          return;
        }
        // Stale handles from a prior generation report through their old
        // activation callback. Preserve the diagnostic on the current host
        // snapshot without reviving the old registry.
        activeRegistry.diagnostics.push(diagnostic);
        if (diagnostic.phase !== "status.evaluate") {
          activeRegistry.errors.push({
            error: diagnostic.error,
            ...(diagnostic.owner ? { owner: diagnostic.owner } : {}),
            path: diagnostic.path ?? diagnostic.owner?.path ?? "",
            phase: diagnostic.phase,
          });
        }
        publish();
      },
    });
    loadingRegistry = nextRegistry;
    if (disposed || loadGeneration !== generation) {
      disposeLocalExtensions(nextRegistry);
      return;
    }

    activeRegistry = nextRegistry;
    publish();
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      disposeLocalExtensions(activeRegistry);
      activeRegistry = createEmptyExtensionRegistry(
        resolveLocalExtensionSources(options),
        generation,
      );
      publish();
      listeners.clear();
    },
    getSnapshot() {
      return snapshot;
    },
    reload,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
