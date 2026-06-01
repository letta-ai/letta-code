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
import { clearAvailableModelsCache } from "@/agent/available-models";
import type { PiProviderRegistration } from "@/backend/dev/pi-provider-extension-registry";
import {
  registerPiProvider,
  unregisterPiProvider,
  unregisterPiProvidersForOwner,
} from "@/backend/dev/pi-provider-extension-registry";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";
import {
  cloneExtensionCapabilities,
  resolveExtensionCapabilities,
} from "@/extensions/capabilities";
import { createExtensionConversationHandle } from "@/extensions/conversation-handle";
import {
  getExtensionToolDefinition,
  registerExtensionTool,
  unregisterExtensionTool,
  unregisterExtensionToolsForOwner,
} from "@/extensions/tool-registry";
import type {
  ExtensionAdapterBackendApi,
  ExtensionCapabilities,
  ExtensionCommand,
  ExtensionCommandRegistration,
  ExtensionContext,
  ExtensionDiagnostic,
  ExtensionEventContext,
  ExtensionEventEmissionResult,
  ExtensionEventHandler,
  ExtensionEventMap,
  ExtensionEventName,
  ExtensionEventRegistration,
  ExtensionEventResultMap,
  ExtensionOwner,
  ExtensionPanel,
  ExtensionPanelContent,
  ExtensionPanelHandle,
  ExtensionPanelOptions,
  ExtensionPanelUpdate,
  ExtensionTool,
  ExtensionToolRegistration,
  ExtensionToolStartEvent,
  ExtensionTurnStartEvent,
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
  capabilities: ExtensionCapabilities;
  client: Letta;
  getClient: () => Promise<Letta>;
  getContext: () => ExtensionContext;
  signal: AbortSignal;
  registerProvider: (
    name: string,
    config: PiProviderRegistration,
  ) => LettaExtensionDisposer;
  unregisterProvider: (name: string) => void;
  commands: {
    register: (command: ExtensionCommandRegistration) => LettaExtensionDisposer;
    unregister: (id: string) => void;
  };
  tools: {
    register: (tool: ExtensionToolRegistration) => LettaExtensionDisposer;
    unregister: (name: string) => void;
  };
  providers: {
    register: (
      name: string,
      config: PiProviderRegistration,
    ) => LettaExtensionDisposer;
    unregister: (name: string) => void;
  };
  events: {
    off: <TName extends ExtensionEventName>(
      name: TName,
      handler: ExtensionEventHandler<TName>,
    ) => void;
    on: <TName extends ExtensionEventName>(
      name: TName,
      handler: ExtensionEventHandler<TName>,
    ) => LettaExtensionDisposer;
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

type LocalExtensionEventsRegistry = Partial<
  Record<ExtensionEventName, ExtensionEventRegistration[]>
>;

export interface LocalExtensionRegistry {
  capabilities: ExtensionCapabilities;
  commands: Record<string, ExtensionCommand>;
  diagnostics: ExtensionDiagnostic[];
  disposers: LocalExtensionDisposer[];
  errors: LocalExtensionLoadError[];
  events: LocalExtensionEventsRegistry;
  generation: number;
  loadedPaths: string[];
  ownerAbortControllers: Record<string, AbortController>;
  owners: Record<string, ExtensionOwner>;
  sources: LocalExtensionSource[];
  tools: Record<string, ExtensionTool>;
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
  backend?: ExtensionAdapterBackendApi;
  capabilities?: ExtensionCapabilities;
  builtinCommandIds?: Iterable<string>;
  generation?: number;
  onChange?: () => void;
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
  reservedToolNames?: Iterable<string>;
}

export interface ExtensionEngine {
  dispose: () => void;
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
    backend?: ExtensionAdapterBackendApi,
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  getSnapshot: () => LocalExtensionRegistry;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export interface CreateExtensionEngineOptions
  extends ResolveLocalExtensionSourcesOptions {
  getContext?: () => ExtensionContext;
  getClient: () => Promise<Letta>;
  backend?: ExtensionAdapterBackendApi;
  builtinCommandIds?: Iterable<string>;
  capabilities?: ExtensionCapabilities;
  reservedToolNames?: Iterable<string>;
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
  capabilities: ExtensionCapabilities,
): LocalExtensionRegistry {
  return {
    capabilities: cloneExtensionCapabilities(capabilities),
    commands: {},
    diagnostics: [],
    disposers: [],
    errors: [],
    events: {},
    generation,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    sources,
    tools: {},
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
  if (
    completeDiagnostic.phase !== "status.evaluate" &&
    completeDiagnostic.phase !== "command.override"
  ) {
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
    capabilities: cloneExtensionCapabilities(registry.capabilities),
    diagnostics: [...registry.diagnostics],
    disposers: [...registry.disposers],
    errors: [...registry.errors],
    events: Object.fromEntries(
      Object.entries(registry.events).map(([name, handlers]) => [
        name,
        handlers ? [...handlers] : [],
      ]),
    ) as LocalExtensionEventsRegistry,
    loadedPaths: [...registry.loadedPaths],
    ownerAbortControllers: { ...registry.ownerAbortControllers },
    owners: { ...registry.owners },
    sources: registry.sources.map((source) => ({
      ...source,
      files: [...source.files],
    })),
    tools: { ...registry.tools },
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
  unregisterPiProvidersForOwner(owner.id);
  clearAvailableModelsCache();

  for (const [id, command] of Object.entries(registry.commands)) {
    if (command.owner?.id === owner.id) {
      delete registry.commands[id];
    }
  }

  for (const [name, registrations] of Object.entries(registry.events)) {
    const nextRegistrations = registrations?.filter(
      (registration) => registration.owner?.id !== owner.id,
    );
    if (nextRegistrations && nextRegistrations.length > 0) {
      registry.events[name as ExtensionEventName] = nextRegistrations;
    } else {
      delete registry.events[name as ExtensionEventName];
    }
  }

  for (const [id, panel] of Object.entries(registry.ui.panels)) {
    if (panel.owner?.id === owner.id) {
      delete registry.ui.panels[id];
    }
  }

  for (const [name, tool] of Object.entries(registry.tools)) {
    if (tool.owner?.id === owner.id) {
      delete registry.tools[name];
    }
  }

  unregisterExtensionToolsForOwner(owner);

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

const SUPPORTED_EXTENSION_EVENT_NAMES = new Set<ExtensionEventName>([
  "conversation_open",
  "conversation_close",
  "tool_start",
  "turn_start",
]);

function validateExtensionEventName(
  name: string,
): asserts name is ExtensionEventName {
  if (!SUPPORTED_EXTENSION_EVENT_NAMES.has(name as ExtensionEventName)) {
    throw new Error(`Unsupported extension event '${name}'`);
  }
}

function isExtensionEventCapabilityEnabled(
  capabilities: ExtensionCapabilities,
  name: ExtensionEventName,
): boolean {
  switch (name) {
    case "conversation_open":
    case "conversation_close":
      return capabilities.events.lifecycle;
    case "tool_start":
      return capabilities.events.tools;
    case "turn_start":
      return capabilities.events.turns;
  }
}

function isTurnStartResultWithInput(
  name: ExtensionEventName,
  result: unknown,
): result is { input: ExtensionTurnStartEvent["input"] } {
  return (
    name === "turn_start" &&
    typeof result === "object" &&
    result !== null &&
    isTurnStartInput((result as { input?: unknown }).input)
  );
}

function isTurnStartInput(
  value: unknown,
): value is ExtensionTurnStartEvent["input"] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

function cloneTurnStartInput(
  input: ExtensionTurnStartEvent["input"],
): ExtensionTurnStartEvent["input"] {
  return input.map((item) => structuredClone(item));
}

function isToolStartResultWithArgs(
  name: ExtensionEventName,
  result: unknown,
): result is { args: ExtensionToolStartEvent["args"] } {
  return (
    name === "tool_start" &&
    typeof result === "object" &&
    result !== null &&
    isToolStartArgs((result as { args?: unknown }).args)
  );
}

function isToolStartArgs(
  value: unknown,
): value is ExtensionToolStartEvent["args"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneToolStartArgs(
  args: ExtensionToolStartEvent["args"],
): ExtensionToolStartEvent["args"] {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
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

function validateExtensionToolName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "Extension tool name must be 1-64 characters using letters, numbers, underscores, or hyphens",
    );
  }
}

function normalizeExtensionToolParameters(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!parameters) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    throw new Error("Extension tool parameters must be a JSON Schema object");
  }
  if (parameters.type !== undefined && parameters.type !== "object") {
    throw new Error(
      "Extension tool parameters schema must be an object schema",
    );
  }
  return parameters;
}

function normalizeExtensionTool(
  tool: ExtensionToolRegistration,
  owner: ExtensionOwner,
): ExtensionTool {
  validateExtensionToolName(tool.name);
  if (!tool.description.trim()) {
    throw new Error(`Extension tool '${tool.name}' must include a description`);
  }
  if (typeof tool.run !== "function") {
    throw new Error(`Extension tool '${tool.name}' must include run()`);
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizeExtensionToolParameters(tool.parameters),
    owner,
    path: owner.path,
    requiresApproval: tool.requiresApproval !== false,
    parallelSafe: tool.parallelSafe === true,
    ...(tool.isEnabled ? { isEnabled: tool.isEnabled } : {}),
    run: tool.run,
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
  capabilities: ExtensionCapabilities,
  getClient: () => Promise<Letta>,
  getContext: () => ExtensionContext,
  onChange: () => void,
  onDiagnostic: ((diagnostic: ExtensionDiagnostic) => void) | undefined,
  builtinCommandIds: Set<string>,
  reservedToolNames: Set<string>,
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

  const unregisterEvent = <TName extends ExtensionEventName>(
    name: TName,
    handler: ExtensionEventHandler<TName>,
  ) => {
    validateExtensionEventName(name);
    if (!isExtensionEventCapabilityEnabled(capabilities, name)) return;
    if (!guardLive({ id: name, kind: "event" })) return;
    const registrations = registry.events[name];
    if (!registrations) return;
    const nextRegistrations = registrations.filter(
      (registration) =>
        registration.owner?.id !== owner.id ||
        registration.handler !== (handler as unknown as ExtensionEventHandler),
    );
    if (nextRegistrations.length > 0) {
      registry.events[name] = nextRegistrations;
    } else {
      delete registry.events[name];
    }
    onChange();
  };

  const unregisterCommand = (id: string) => {
    if (!capabilities.commands) return;
    validateExtensionCommandId(id);
    if (!guardLive({ id, kind: "command" })) return;
    const existing = registry.commands[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.commands[id];
      onChange();
    }
  };

  const clearPanel = (id: string) => {
    if (!capabilities.ui.panels) return;
    validateExtensionPanelId(id);
    if (!guardLive({ id, kind: "panel" })) return;
    const panelKey = getExtensionPanelKey(owner.id, id);
    const existing = registry.ui.panels[panelKey];
    if (existing?.owner?.id === owner.id) {
      delete registry.ui.panels[panelKey];
      onChange();
    }
  };

  const unregisterTool = (name: string) => {
    if (!capabilities.tools) return;
    validateExtensionToolName(name);
    if (!guardLive({ id: name, kind: "tool" })) return;
    const existing = registry.tools[name];
    if (existing?.owner?.id === owner.id) {
      delete registry.tools[name];
      unregisterExtensionTool(name, owner);
      onChange();
    }
  };

  const unregisterProvider = (name: string) => {
    if (!capabilities.providers) return;
    if (!guardLive({ id: name, kind: "provider" })) return;
    unregisterPiProvider(name, owner.id);
    clearAvailableModelsCache();
    onChange();
  };

  const registerProviderForOwner = (
    name: string,
    config: PiProviderRegistration,
  ): LettaExtensionDisposer => {
    if (!capabilities.providers) {
      return () => undefined;
    }
    if (!guardLive({ id: name, kind: "provider" })) {
      return () => undefined;
    }
    registerPiProvider(name, config, {
      id: owner.id,
      path: owner.path,
    });
    clearAvailableModelsCache();
    onChange();
    return () => unregisterProvider(name);
  };

  const onEvent = <TName extends ExtensionEventName>(
    name: TName,
    handler: ExtensionEventHandler<TName>,
  ): LettaExtensionDisposer => {
    validateExtensionEventName(name);
    if (!isExtensionEventCapabilityEnabled(capabilities, name)) {
      return () => undefined;
    }
    if (typeof handler !== "function") {
      throw new Error("Extension event registration must include a handler");
    }
    if (!guardLive({ id: name, kind: "event" })) {
      return () => undefined;
    }

    registry.events[name] = [
      ...(registry.events[name] ?? []),
      {
        handler: handler as unknown as ExtensionEventHandler,
        name,
        owner,
        path: owner.path,
      },
    ];
    onChange();

    return () => unregisterEvent(name, handler);
  };

  return {
    capabilities: cloneExtensionCapabilities(capabilities),
    client: createLazyClient(getClient),
    getClient,
    getContext,
    signal,
    registerProvider: registerProviderForOwner,
    unregisterProvider,
    commands: {
      register(command) {
        if (!capabilities.commands) {
          return () => undefined;
        }
        if (!guardLive({ id: command.id, kind: "command" })) {
          return () => undefined;
        }

        const normalized = normalizeExtensionCommand(command, owner);
        if (builtinCommandIds.has(normalized.id)) {
          recordExtensionDiagnostic(
            registry,
            {
              capability: { id: normalized.id, kind: "command" },
              error: new Error(
                `Extension command '${normalized.id}' overrides a built-in command`,
              ),
              owner,
              path: owner.path,
              phase: "command.override",
            },
            onDiagnostic,
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
    tools: {
      register(tool) {
        if (!capabilities.tools) {
          return () => undefined;
        }
        if (!guardLive({ id: tool.name, kind: "tool" })) {
          return () => undefined;
        }

        const normalized = normalizeExtensionTool(tool, owner);
        if (reservedToolNames.has(normalized.name)) {
          throw new Error(
            `Extension tool '${normalized.name}' conflicts with a built-in tool`,
          );
        }

        const existing = registry.tools[normalized.name];
        const existingGlobal = getExtensionToolDefinition(normalized.name);
        if ((existing || existingGlobal) && !tool.override) {
          throw new Error(
            `Extension tool '${normalized.name}' is already registered by ${existing?.path ?? existingGlobal?.path}`,
          );
        }

        registry.tools[normalized.name] = normalized;
        registerExtensionTool({
          ...normalized,
          activationSignal: signal,
          getContext,
          isAvailable: () => {
            if (signal.aborted) return false;
            return normalized.isEnabled?.(getContext()) ?? true;
          },
        });
        onChange();

        return () => unregisterTool(normalized.name);
      },
      unregister: unregisterTool,
    },
    providers: {
      register(name, config) {
        return registerProviderForOwner(name, config);
      },
      unregister: unregisterProvider,
    },
    events: {
      off: unregisterEvent,
      on: onEvent,
    },
    ui: {
      clearPanel,
      clearStatus(key) {
        if (!capabilities.ui.statusValues) return;
        if (!guardLive({ id: key, kind: "status" })) return;
        delete registry.ui.statusValues[key];
        delete registry.ui.statusOwners[key];
        onChange();
      },
      openPanel(panel) {
        if (!capabilities.ui.panels) {
          return {
            close() {},
            update() {},
          };
        }
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
        if (!capabilities.ui.statusValues) return;
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
        if (!capabilities.ui.customStatuslineRenderer) return;
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
  const capabilities = resolveExtensionCapabilities(options.capabilities);
  const generation = options.generation ?? 1;
  const builtinCommandIds = new Set([...(options.builtinCommandIds ?? [])]);
  const reservedToolNames = new Set([...(options.reservedToolNames ?? [])]);
  const registry = createEmptyExtensionRegistry(
    sources,
    generation,
    capabilities,
  );

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
            capabilities,
            getConfiguredClient,
            getContext,
            onChange,
            options.onDiagnostic,
            builtinCommandIds,
            reservedToolNames,
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

export async function emitLocalExtensionEvent<TName extends ExtensionEventName>(
  registry: LocalExtensionRegistry | null,
  name: TName,
  event: ExtensionEventMap[TName],
  getContext: () => ExtensionContext,
  backend?: ExtensionAdapterBackendApi,
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): Promise<ExtensionEventEmissionResult<TName>> {
  if (!registry) {
    return { diagnostics: [], handlerCount: 0, name, results: [] };
  }

  validateExtensionEventName(name);
  const registrations = [...(registry.events[name] ?? [])];
  const diagnostics: ExtensionDiagnostic[] = [];
  const results: Array<NonNullable<ExtensionEventResultMap[TName]>> = [];

  for (const registration of registrations) {
    const signal = registration.owner
      ? registry.ownerAbortControllers[registration.owner.id]?.signal
      : undefined;
    if (signal?.aborted) continue;
    const turnStartEvent =
      name === "turn_start" ? (event as ExtensionTurnStartEvent) : null;
    const turnStartInputBeforeHandler =
      turnStartEvent && isTurnStartInput(turnStartEvent.input)
        ? cloneTurnStartInput(turnStartEvent.input)
        : null;
    const toolStartEvent =
      name === "tool_start" ? (event as ExtensionToolStartEvent) : null;
    const toolStartArgsBeforeHandler =
      toolStartEvent && isToolStartArgs(toolStartEvent.args)
        ? cloneToolStartArgs(toolStartEvent.args)
        : null;

    try {
      const context = getContext();
      const eventContext: ExtensionEventContext = {
        conversation: createExtensionConversationHandle({
          agentId:
            typeof event.agentId === "string"
              ? event.agentId
              : context.agent.id,
          backend,
          conversationId:
            typeof event.conversationId === "string"
              ? event.conversationId
              : context.sessionId,
          workingDirectory: context.cwd,
        }),
        context,
        getContext,
        signal: signal ?? new AbortController().signal,
      };
      const result = await registration.handler(event, eventContext);
      if (isTurnStartResultWithInput(name, result)) {
        (event as ExtensionTurnStartEvent).input = result.input;
      }
      if (isToolStartResultWithArgs(name, result)) {
        (event as ExtensionToolStartEvent).args = result.args;
      }
      if (result != null) {
        results.push(result as NonNullable<ExtensionEventResultMap[TName]>);
      }
      if (
        turnStartEvent &&
        turnStartInputBeforeHandler &&
        !isTurnStartInput(turnStartEvent.input)
      ) {
        turnStartEvent.input = turnStartInputBeforeHandler;
      }
      if (
        toolStartEvent &&
        toolStartArgsBeforeHandler &&
        !isToolStartArgs(toolStartEvent.args)
      ) {
        toolStartEvent.args = toolStartArgsBeforeHandler;
      }
    } catch (error) {
      if (turnStartEvent && turnStartInputBeforeHandler) {
        turnStartEvent.input = turnStartInputBeforeHandler;
      }
      if (toolStartEvent && toolStartArgsBeforeHandler) {
        toolStartEvent.args = toolStartArgsBeforeHandler;
      }
      recordExtensionDiagnostic(
        registry,
        {
          capability: { id: name, kind: "event" },
          error: error instanceof Error ? error : new Error(String(error)),
          ...(registration.owner ? { owner: registration.owner } : {}),
          path: registration.path,
          phase: "event",
        },
        onDiagnostic,
      );
      const diagnostic = registry.diagnostics.at(-1);
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  return { diagnostics, handlerCount: registrations.length, name, results };
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

  for (const owner of Object.values(registry.owners)) {
    unregisterPiProvidersForOwner(owner.id);
    unregisterExtensionToolsForOwner(owner);
  }
  clearAvailableModelsCache();

  registry.commands = {};
  registry.events = {};
  registry.ownerAbortControllers = {};
  registry.owners = {};
  registry.tools = {};
  registry.ui.panels = {};
  registry.ui.statusOwners = {};
  registry.ui.statusValues = {};
  registry.ui.statuslineRenderer = null;
  delete registry.ui.statuslineRendererOwner;
}

export function createExtensionEngine(
  options: CreateExtensionEngineOptions,
): ExtensionEngine {
  let generation = 0;
  let disposed = false;
  const capabilities = resolveExtensionCapabilities(options.capabilities);
  const getContext =
    options.getContext ??
    (() => {
      throw new Error("Extension context is not available yet");
    });
  let activeRegistry = createEmptyExtensionRegistry(
    resolveLocalExtensionSources(options),
    generation,
    capabilities,
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
      capabilities,
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
        // activation callback. Preserve the diagnostic on the current engine
        // snapshot without reviving the old registry.
        activeRegistry.diagnostics.push(diagnostic);
        if (
          diagnostic.phase !== "status.evaluate" &&
          diagnostic.phase !== "command.override"
        ) {
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
        capabilities,
      );
      publish();
      listeners.clear();
    },
    async emitEvent(name, payload, backend) {
      if (disposed) {
        return { diagnostics: [], handlerCount: 0, name, results: [] };
      }
      const result = await emitLocalExtensionEvent(
        activeRegistry,
        name,
        payload,
        getContext,
        backend ?? options.backend,
      );
      if (result.diagnostics.length > 0) {
        publish();
      }
      return result;
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
