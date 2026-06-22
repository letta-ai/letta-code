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
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Letta from "@letta-ai/letta-client";
import * as ts from "typescript";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import type { PiProviderRegistration } from "@/backend/dev/pi-provider-mod-registry";
import {
  registerPiProvider,
  unregisterPiProvider,
  unregisterPiProvidersForOwner,
} from "@/backend/dev/pi-provider-mod-registry";
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";
import {
  cloneModCapabilities,
  resolveModCapabilities,
} from "@/mods/capabilities";
import { createModConversationHandle } from "@/mods/conversation-handle";
import {
  attachDeprecatedGetContextTrap,
  recordDeprecatedContextApiSourceDiagnostics,
} from "@/mods/deprecated-api";
import {
  isModFileExtension,
  isTypeScriptModFileExtension,
} from "@/mods/file-extensions";
import {
  appendModDiagnostic,
  recordModDiagnostic,
  recordStaleHandleUse,
} from "@/mods/mod-diagnostics";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
  getModCacheDirectory,
  resolveDefaultGlobalModsDirectory,
} from "@/mods/paths";
import {
  getModPermissionDefinition,
  registerModPermission,
  unregisterModPermission,
  unregisterModPermissionsForOwner,
} from "@/mods/permission-registry";
import {
  getModToolDefinition,
  registerModTool,
  unregisterModTool,
  unregisterModToolsForOwner,
} from "@/mods/tool-registry";
import type {
  ModCapabilities,
  ModCommand,
  ModCommandRegistration,
  ModContext,
  ModDiagnostic,
  ModDiagnosticReportOptions,
  ModDiagnosticSeverity,
  ModEventContext,
  ModEventEmissionResult,
  ModEventHandler,
  ModEventMap,
  ModEventName,
  ModEventRegistration,
  ModEventResultMap,
  ModInvocationContext,
  ModOwner,
  ModPanel,
  ModPanelContent,
  ModPanelHandle,
  ModPanelOptions,
  ModPanelUpdate,
  ModPermission,
  ModPermissionRegistration,
  ModTool,
  ModToolRegistration,
  ModToolStartEvent,
  ModTurnStartEvent,
} from "@/mods/types";

export const GLOBAL_MODS_DIRECTORY = getGlobalModsDirectory();
export const LEGACY_GLOBAL_EXTENSIONS_DIRECTORY =
  getLegacyGlobalExtensionsDirectory();
export const MOD_CACHE_DIRECTORY = getModCacheDirectory();

const requireFromRuntime = createRequire(import.meta.url);

export type StatuslineRenderFunction = (
  context: StatuslineRenderContext,
) => StatuslineRendererOutput;

export type ModStatusValue =
  | string
  | null
  | ((context: ModInvocationContext) => string | null);

export type LettaModDisposer = () => void;

export type ModCapabilityDiagnosticRecorder = (
  diagnostic: Pick<
    ModDiagnostic,
    "capability" | "error" | "phase" | "severity"
  >,
) => void;

export type LettaModFactory = (
  letta: LettaModApi,
) => undefined | LettaModDisposer | Promise<undefined | LettaModDisposer>;

export interface LettaModApi {
  capabilities: ModCapabilities;
  client: Letta;
  getClient: () => Promise<Letta>;
  signal: AbortSignal;
  registerProvider: (
    name: string,
    config: PiProviderRegistration,
  ) => LettaModDisposer;
  unregisterProvider: (name: string) => void;
  commands: {
    register: (command: ModCommandRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  tools: {
    register: (tool: ModToolRegistration) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  providers: {
    register: (
      name: string,
      config: PiProviderRegistration,
    ) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  events: {
    off: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => void;
    on: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => LettaModDisposer;
  };
  permissions: {
    register: (permission: ModPermissionRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  diagnostics: {
    report: (diagnostic: ModDiagnosticReportOptions) => void;
  };
  ui: {
    clearPanel: (id: string) => void;
    clearStatus: (key: string) => void;
    openPanel: (panel: ModPanelOptions) => ModPanelHandle;
    setStatus: (key: string, value: ModStatusValue | undefined) => void;
    setStatuslineRenderer: (
      renderer: StatuslineRenderer | StatuslineRenderFunction,
    ) => void;
  };
}

export interface LocalModDisposer {
  abortController?: AbortController;
  dispose: LettaModDisposer;
  owner: ModOwner;
}

export interface LocalModUiRegistry {
  panels: Record<string, ModPanel>;
  statuslineRecordDiagnostic?: ModCapabilityDiagnosticRecorder;
  statuslineRenderer: StatuslineRenderer | null;
  statuslineRendererOwner?: ModOwner;
  statusOwners: Record<string, ModOwner>;
  statusRecorders: Record<string, ModCapabilityDiagnosticRecorder>;
  statusValues: Record<string, ModStatusValue>;
}

type LocalModEventsRegistry = Partial<
  Record<ModEventName, ModEventRegistration[]>
>;

export interface LocalModRegistry {
  capabilities: ModCapabilities;
  commands: Record<string, ModCommand>;
  diagnostics: ModDiagnostic[];
  disposers: LocalModDisposer[];
  events: LocalModEventsRegistry;
  generation: number;
  loadedPaths: string[];
  ownerAbortControllers: Record<string, AbortController>;
  owners: Record<string, ModOwner>;
  permissions: Record<string, ModPermission>;
  sources: LocalModSource[];
  tools: Record<string, ModTool>;
  ui: LocalModUiRegistry;
}

export interface LocalModSource {
  files: string[];
  root: string;
  scope: "global" | "project" | "bundled";
  trusted: boolean;
}

interface LocalModModule {
  activate?: unknown;
  default?: unknown;
}

export interface ResolveLocalModSourcesOptions {
  cacheDirectory?: string;
  globalModsDirectory?: string;
}

export interface LoadLocalModsOptions extends ResolveLocalModSourcesOptions {
  getClient: () => Promise<Letta>;
  capabilities?: ModCapabilities;
  builtinCommandIds?: Iterable<string>;
  generation?: number;
  onChange?: () => void;
  onDiagnostic?: (diagnostic: ModDiagnostic) => void;
  reservedToolNames?: Iterable<string>;
}

export interface ModEngine {
  dispose: () => void;
  emitEvent: <TName extends ModEventName>(
    name: TName,
    event: ModEventMap[TName],
    context: ModContext,
  ) => Promise<ModEventEmissionResult<TName>>;
  getSnapshot: () => LocalModRegistry;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export interface CreateModEngineOptions extends ResolveLocalModSourcesOptions {
  getClient: () => Promise<Letta>;
  getBackend?: () => Backend | undefined;
  builtinCommandIds?: Iterable<string>;
  capabilities?: ModCapabilities;
  onDiagnostic?: (diagnostic: ModDiagnostic) => void;
  reservedToolNames?: Iterable<string>;
}

function listModFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.startsWith(".")) return false;
      return isModFileExtension(path.extname(entry.name));
    })
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function resolveLocalModSources(
  options: ResolveLocalModSourcesOptions = {},
): LocalModSource[] {
  const globalModsDirectory =
    options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory();

  return [
    {
      files: listModFiles(globalModsDirectory),
      root: globalModsDirectory,
      scope: "global",
      trusted: true,
    },
  ];
}

function createEmptyModRegistry(
  sources: LocalModSource[],
  generation: number,
  capabilities: ModCapabilities,
): LocalModRegistry {
  return {
    capabilities: cloneModCapabilities(capabilities),
    commands: {},
    diagnostics: [],
    disposers: [],
    events: {},
    generation,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    permissions: {},
    sources,
    tools: {},
    ui: {
      panels: {},
      statusRecorders: {},
      statuslineRenderer: null,
      statusOwners: {},
      statusValues: {},
    },
  };
}

function createModOwner(
  modPath: string,
  source: LocalModSource,
  generation: number,
): ModOwner {
  return {
    id: `${source.scope}:${modPath}`,
    path: modPath,
    scope: source.scope,
    generation,
  };
}

function isOwnerLive(registry: LocalModRegistry, owner: ModOwner): boolean {
  return registry.owners[owner.id]?.generation === owner.generation;
}

function snapshotRegistryForReaders(
  registry: LocalModRegistry,
): LocalModRegistry {
  return {
    ...registry,
    commands: { ...registry.commands },
    capabilities: cloneModCapabilities(registry.capabilities),
    diagnostics: [...registry.diagnostics],
    disposers: [...registry.disposers],
    events: Object.fromEntries(
      Object.entries(registry.events).map(([name, handlers]) => [
        name,
        handlers ? [...handlers] : [],
      ]),
    ) as LocalModEventsRegistry,
    loadedPaths: [...registry.loadedPaths],
    ownerAbortControllers: { ...registry.ownerAbortControllers },
    owners: { ...registry.owners },
    permissions: { ...registry.permissions },
    sources: registry.sources.map((source) => ({
      ...source,
      files: [...source.files],
    })),
    tools: { ...registry.tools },
    ui: {
      ...registry.ui,
      panels: { ...registry.ui.panels },
      statusRecorders: { ...registry.ui.statusRecorders },
      statusOwners: { ...registry.ui.statusOwners },
      statusValues: { ...registry.ui.statusValues },
    },
  };
}

function removeOwnerCapabilities(
  registry: LocalModRegistry,
  owner: ModOwner,
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
      registry.events[name as ModEventName] = nextRegistrations;
    } else {
      delete registry.events[name as ModEventName];
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

  unregisterModToolsForOwner(owner);

  for (const [key, statusOwner] of Object.entries(registry.ui.statusOwners)) {
    if (statusOwner.id === owner.id) {
      delete registry.ui.statusOwners[key];
      delete registry.ui.statusRecorders[key];
      delete registry.ui.statusValues[key];
    }
  }

  if (registry.ui.statuslineRendererOwner?.id === owner.id) {
    registry.ui.statuslineRenderer = null;
    delete registry.ui.statuslineRecordDiagnostic;
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

function ensureModCache(cacheDirectory: string): void {
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

function transpileTypeScriptMod(modPath: string, source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: modPath,
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

function prepareModForImport(modPath: string, source: string): string {
  const fileExtension = path.extname(modPath);
  if (isTypeScriptModFileExtension(fileExtension)) {
    return transpileTypeScriptMod(modPath, source);
  }

  return source;
}

function createImportableModPath(
  modPath: string,
  cacheDirectory: string,
): string {
  ensureModCache(cacheDirectory);

  const source = readFileSync(modPath, "utf8");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const fileExtension = path.extname(modPath);
  const importableSource = prepareModForImport(modPath, source);
  const baseName = path
    .basename(modPath, fileExtension)
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const importPath = path.join(
    cacheDirectory,
    `.letta-mod-${baseName}-${hash}.mjs`,
  );

  if (!existsSync(importPath)) {
    writeFileSync(importPath, importableSource, "utf8");
  }

  try {
    for (const entry of readdirSync(cacheDirectory)) {
      if (
        entry.startsWith(`.letta-mod-${baseName}-`) &&
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
  modPath: string,
): StatuslineRenderer {
  if (typeof renderer === "function") {
    return {
      id: `local:${modPath}`,
      label: path.basename(modPath),
      description: modPath,
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

const SUPPORTED_MOD_EVENT_NAMES = new Set<ModEventName>([
  "conversation_open",
  "conversation_close",
  "tool_start",
  "turn_start",
]);

function validateModEventName(name: string): asserts name is ModEventName {
  if (!SUPPORTED_MOD_EVENT_NAMES.has(name as ModEventName)) {
    throw new Error(`Unsupported mod event '${name}'`);
  }
}

function isModEventCapabilityEnabled(
  capabilities: ModCapabilities,
  name: ModEventName,
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
  name: ModEventName,
  result: unknown,
): result is { input: ModTurnStartEvent["input"] } {
  return (
    name === "turn_start" &&
    typeof result === "object" &&
    result !== null &&
    isTurnStartInput((result as { input?: unknown }).input)
  );
}

function isTurnStartInput(value: unknown): value is ModTurnStartEvent["input"] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

function cloneTurnStartInput(
  input: ModTurnStartEvent["input"],
): ModTurnStartEvent["input"] {
  return input.map((item) => structuredClone(item));
}

function isToolStartResultWithArgs(
  name: ModEventName,
  result: unknown,
): result is { args: ModToolStartEvent["args"] } {
  return (
    name === "tool_start" &&
    typeof result === "object" &&
    result !== null &&
    isToolStartArgs((result as { args?: unknown }).args)
  );
}

function isToolStartArgs(value: unknown): value is ModToolStartEvent["args"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneToolStartArgs(
  args: ModToolStartEvent["args"],
): ModToolStartEvent["args"] {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
}

function validateModCommandId(id: string): void {
  if (id.startsWith("/")) {
    throw new Error("Mod command id must not start with '/'");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Mod command id must be a lowercase slug using letters, numbers, and hyphens",
    );
  }
}

function normalizeModCommand(
  command: ModCommandRegistration,
  owner: ModOwner,
): ModCommand {
  validateModCommandId(command.id);
  if (!command.description.trim()) {
    throw new Error(`Mod command '${command.id}' must include a description`);
  }
  if (typeof command.run !== "function") {
    throw new Error(`Mod command '${command.id}' must include run()`);
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

function validateModPermissionId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Mod permission id must be a lowercase slug using letters, numbers, and hyphens",
    );
  }
}

function normalizeModPermission(
  permission: ModPermissionRegistration,
  owner: ModOwner,
): ModPermission {
  validateModPermissionId(permission.id);
  if (typeof permission.check !== "function") {
    throw new Error(`Mod permission '${permission.id}' must include check()`);
  }

  return {
    id: permission.id,
    ...(permission.description ? { description: permission.description } : {}),
    owner,
    path: owner.path,
    ...(permission.isEnabled ? { isEnabled: permission.isEnabled } : {}),
    check: permission.check,
  };
}

function validateModToolName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "Mod tool name must be 1-64 characters using letters, numbers, underscores, or hyphens",
    );
  }
}

function normalizeModToolParameters(
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
    throw new Error("Mod tool parameters must be a JSON Schema object");
  }
  if (parameters.type !== undefined && parameters.type !== "object") {
    throw new Error("Mod tool parameters schema must be an object schema");
  }
  return parameters;
}

function normalizeModToolApprovalPolicy(
  tool: ModToolRegistration,
): ModTool["approvalPolicy"] {
  if (tool.approvalPolicy !== undefined) {
    if (
      tool.approvalPolicy === "auto" ||
      tool.approvalPolicy === "ask" ||
      tool.approvalPolicy === "alwaysAsk"
    ) {
      return tool.approvalPolicy;
    }
    throw new Error(
      `Mod tool '${tool.name}' approvalPolicy must be "auto", "ask", or "alwaysAsk"`,
    );
  }
  return tool.requiresApproval === false ? "auto" : "ask";
}

function normalizeModTool(tool: ModToolRegistration, owner: ModOwner): ModTool {
  validateModToolName(tool.name);
  if (!tool.description.trim()) {
    throw new Error(`Mod tool '${tool.name}' must include a description`);
  }
  if (typeof tool.run !== "function") {
    throw new Error(`Mod tool '${tool.name}' must include run()`);
  }

  const approvalPolicy = normalizeModToolApprovalPolicy(tool);

  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizeModToolParameters(tool.parameters),
    owner,
    path: owner.path,
    requiresApproval: approvalPolicy !== "auto",
    approvalPolicy,
    parallelSafe: tool.parallelSafe === true,
    ...(tool.isEnabled ? { isEnabled: tool.isEnabled } : {}),
    run: tool.run,
  };
}

function validateModPanelId(id: string): void {
  if (!id.trim()) {
    throw new Error("Mod panel id must not be empty");
  }
}

function getModPanelKey(modPath: string, id: string): string {
  return JSON.stringify([modPath, id]);
}

function normalizePanelContent(content: ModPanelContent | undefined): string[] {
  if (content == null) return [];
  return Array.isArray(content)
    ? content.map(String)
    : String(content).split("\n");
}

function upsertModPanel(
  registry: LocalModRegistry,
  owner: ModOwner,
  id: string,
  update: ModPanelUpdate,
): void {
  validateModPanelId(id);
  const panelKey = getModPanelKey(owner.id, id);
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

function createLettaModApi(
  registry: LocalModRegistry,
  owner: ModOwner,
  capabilities: ModCapabilities,
  getClient: () => Promise<Letta>,
  onChange: () => void,
  onDiagnostic: ((diagnostic: ModDiagnostic) => void) | undefined,
  builtinCommandIds: Set<string>,
  reservedToolNames: Set<string>,
  signal: AbortSignal,
): LettaModApi {
  const isLive = () => isOwnerLive(registry, owner);
  const guardLive = (capability: ModDiagnostic["capability"]): boolean => {
    if (isLive()) return true;
    recordStaleHandleUse(registry, owner, capability, onDiagnostic);
    return false;
  };
  const recordCapabilityDiagnostic = (
    diagnostic: Pick<
      ModDiagnostic,
      "capability" | "error" | "phase" | "severity"
    >,
  ): void => {
    if (!isLive()) return;
    recordModDiagnostic(
      registry,
      {
        ...diagnostic,
        owner,
      },
      onDiagnostic,
    );
    onChange();
  };

  const unregisterEvent = <TName extends ModEventName>(
    name: TName,
    handler: ModEventHandler<TName>,
  ) => {
    validateModEventName(name);
    if (!isModEventCapabilityEnabled(capabilities, name)) return;
    if (!guardLive({ id: name, kind: "event" })) return;
    const registrations = registry.events[name];
    if (!registrations) return;
    const nextRegistrations = registrations.filter(
      (registration) =>
        registration.owner?.id !== owner.id ||
        registration.handler !== (handler as unknown as ModEventHandler),
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
    validateModCommandId(id);
    if (!guardLive({ id, kind: "command" })) return;
    const existing = registry.commands[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.commands[id];
      onChange();
    }
  };

  const unregisterPermission = (id: string) => {
    if (!capabilities.permissions) return;
    validateModPermissionId(id);
    if (!guardLive({ id, kind: "permission" })) return;
    const existing = registry.permissions[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.permissions[id];
      unregisterModPermission(id, owner);
      onChange();
    }
  };

  const clearPanel = (id: string) => {
    if (!capabilities.ui.panels) return;
    validateModPanelId(id);
    if (!guardLive({ id, kind: "panel" })) return;
    const panelKey = getModPanelKey(owner.id, id);
    const existing = registry.ui.panels[panelKey];
    if (existing?.owner?.id === owner.id) {
      delete registry.ui.panels[panelKey];
      onChange();
    }
  };

  const unregisterTool = (name: string) => {
    if (!capabilities.tools) return;
    validateModToolName(name);
    if (!guardLive({ id: name, kind: "tool" })) return;
    const existing = registry.tools[name];
    if (existing?.owner?.id === owner.id) {
      delete registry.tools[name];
      unregisterModTool(name, owner);
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
  ): LettaModDisposer => {
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

  const normalizeReportedDiagnostic = (
    diagnostic: ModDiagnosticReportOptions,
  ): { message: string; severity: ModDiagnosticSeverity } => {
    if (!diagnostic || typeof diagnostic !== "object") {
      throw new Error("Mod diagnostic report must be an object");
    }
    if (typeof diagnostic.message !== "string") {
      throw new Error("Mod diagnostic report must include a message");
    }
    const message = diagnostic.message.trim();
    if (message.length === 0) {
      throw new Error("Mod diagnostic report message cannot be empty");
    }
    if (
      diagnostic.severity !== undefined &&
      diagnostic.severity !== "error" &&
      diagnostic.severity !== "warning"
    ) {
      throw new Error("Mod diagnostic severity must be 'error' or 'warning'");
    }
    return { message, severity: diagnostic.severity ?? "error" };
  };

  const reportDiagnostic = (diagnostic: ModDiagnosticReportOptions) => {
    if (!guardLive(undefined)) return;
    const normalized = normalizeReportedDiagnostic(diagnostic);
    const error = new Error(normalized.message);
    error.name = "ModDiagnosticReport";
    error.stack = undefined;
    recordModDiagnostic(
      registry,
      {
        error,
        owner,
        phase: "report",
        severity: normalized.severity,
      },
      onDiagnostic,
    );
  };

  const onEvent = <TName extends ModEventName>(
    name: TName,
    handler: ModEventHandler<TName>,
  ): LettaModDisposer => {
    validateModEventName(name);
    if (!isModEventCapabilityEnabled(capabilities, name)) {
      return () => undefined;
    }
    if (typeof handler !== "function") {
      throw new Error("Mod event registration must include a handler");
    }
    if (!guardLive({ id: name, kind: "event" })) {
      return () => undefined;
    }

    registry.events[name] = [
      ...(registry.events[name] ?? []),
      {
        handler: handler as unknown as ModEventHandler,
        name,
        owner,
      },
    ];
    onChange();

    return () => unregisterEvent(name, handler);
  };

  const api: LettaModApi = {
    capabilities: cloneModCapabilities(capabilities),
    client: createLazyClient(getClient),
    getClient,
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

        const normalized = normalizeModCommand(command, owner);
        if (builtinCommandIds.has(normalized.id)) {
          recordModDiagnostic(
            registry,
            {
              capability: { id: normalized.id, kind: "command" },
              error: new Error(
                `Mod command '${normalized.id}' overrides a built-in command`,
              ),
              owner,
              phase: "command_override",
            },
            onDiagnostic,
          );
        }

        const existing = registry.commands[normalized.id];
        if (existing && !command.override) {
          throw new Error(
            `Mod command '${normalized.id}' is already registered by ${existing.path}`,
          );
        }

        registry.commands[normalized.id] = {
          ...normalized,
          recordDiagnostic: recordCapabilityDiagnostic,
        };
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

        const normalized = normalizeModTool(tool, owner);
        if (reservedToolNames.has(normalized.name)) {
          throw new Error(
            `Mod tool '${normalized.name}' conflicts with a built-in tool`,
          );
        }

        const existing = registry.tools[normalized.name];
        const existingGlobal = getModToolDefinition(normalized.name);
        if ((existing || existingGlobal) && !tool.override) {
          throw new Error(
            `Mod tool '${normalized.name}' is already registered by ${existing?.path ?? existingGlobal?.path}`,
          );
        }

        registry.tools[normalized.name] = normalized;
        registerModTool({
          ...normalized,
          activationSignal: signal,
          recordDiagnostic: recordCapabilityDiagnostic,
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
    permissions: {
      register(permission) {
        if (!capabilities.permissions) {
          return () => undefined;
        }
        if (!guardLive({ id: permission.id, kind: "permission" })) {
          return () => undefined;
        }

        const normalized = normalizeModPermission(permission, owner);
        const existing = registry.permissions[normalized.id];
        const existingGlobal = getModPermissionDefinition(normalized.id);
        if (existing || existingGlobal) {
          throw new Error(
            `Mod permission '${normalized.id}' is already registered by ${existing?.path ?? existingGlobal?.path}`,
          );
        }

        registry.permissions[normalized.id] = normalized;
        registerModPermission({
          ...normalized,
          activationSignal: signal,
          recordDiagnostic: recordCapabilityDiagnostic,
        });
        onChange();

        return () => unregisterPermission(normalized.id);
      },
      unregister: unregisterPermission,
    },
    diagnostics: {
      report: reportDiagnostic,
    },
    ui: {
      clearPanel,
      clearStatus(key) {
        if (!capabilities.ui.statusValues) return;
        if (!guardLive({ id: key, kind: "status" })) return;
        delete registry.ui.statusValues[key];
        delete registry.ui.statusOwners[key];
        delete registry.ui.statusRecorders[key];
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

        upsertModPanel(registry, owner, panel.id, panel);
        onChange();
        return {
          close() {
            clearPanel(panel.id);
          },
          update(update) {
            if (!guardLive({ id: panel.id, kind: "panel" })) return;
            upsertModPanel(registry, owner, panel.id, update);
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
          delete registry.ui.statusRecorders[key];
          onChange();
          return;
        }
        registry.ui.statusValues[key] = value;
        registry.ui.statusOwners[key] = owner;
        registry.ui.statusRecorders[key] = recordCapabilityDiagnostic;
        onChange();
      },
      setStatuslineRenderer(renderer) {
        if (!capabilities.ui.customStatuslineRenderer) return;
        if (!guardLive({ id: owner.id, kind: "statusline" })) return;
        registry.ui.statuslineRenderer = toStatuslineRenderer(
          renderer,
          owner.path,
        );
        registry.ui.statuslineRecordDiagnostic = recordCapabilityDiagnostic;
        registry.ui.statuslineRendererOwner = owner;
        onChange();
      },
    },
  };

  return attachDeprecatedGetContextTrap(
    api,
    recordCapabilityDiagnostic,
    "letta.getContext",
  );
}

function getModFactory(module: LocalModModule): unknown {
  return typeof module.default === "function"
    ? module.default
    : module.activate;
}

export async function loadLocalMods(
  options: LoadLocalModsOptions,
): Promise<LocalModRegistry> {
  const cacheDirectory = options.cacheDirectory ?? MOD_CACHE_DIRECTORY;
  let clientPromise: Promise<Letta> | null = null;
  const getConfiguredClient = () => {
    clientPromise ??= options.getClient();
    return clientPromise;
  };
  const onChange = options.onChange ?? (() => {});
  const sources = resolveLocalModSources(options);
  const capabilities = resolveModCapabilities(options.capabilities);
  const generation = options.generation ?? 1;
  const builtinCommandIds = new Set([...(options.builtinCommandIds ?? [])]);
  const reservedToolNames = new Set([...(options.reservedToolNames ?? [])]);
  const registry = createEmptyModRegistry(sources, generation, capabilities);

  for (const source of sources) {
    for (const modPath of source.files) {
      const owner = createModOwner(modPath, source, generation);
      const abortController = new AbortController();
      let failurePhase: ModDiagnostic["phase"] = "import";
      registry.ownerAbortControllers[owner.id] = abortController;
      registry.owners[owner.id] = owner;

      try {
        const mtimeMs = statSync(modPath).mtimeMs;
        const sourceText = readFileSync(modPath, "utf8");
        recordDeprecatedContextApiSourceDiagnostics(
          sourceText,
          (diagnostic) => {
            recordModDiagnostic(
              registry,
              {
                ...diagnostic,
                owner,
              },
              options.onDiagnostic,
            );
          },
        );
        failurePhase = isTypeScriptModFileExtension(path.extname(modPath))
          ? "transpile"
          : "import";
        const importPath = createImportableModPath(modPath, cacheDirectory);
        failurePhase = "import";
        const module = (await import(
          `${pathToFileURL(importPath).href}?mod=${mtimeMs}`
        )) as LocalModModule;
        const factory = getModFactory(module);
        failurePhase = "activate";

        if (typeof factory !== "function") {
          throw new Error(
            "Mod must export a default function or activate() function",
          );
        }

        const dispose = await (factory as LettaModFactory)(
          createLettaModApi(
            registry,
            owner,
            capabilities,
            getConfiguredClient,
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
          });
        }
        registry.loadedPaths.push(modPath);
      } catch (error) {
        removeOwnerCapabilities(registry, owner);
        abortController.abort("mod activation failed");
        delete registry.ownerAbortControllers[owner.id];
        recordModDiagnostic(
          registry,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            owner,
            phase: failurePhase,
          },
          options.onDiagnostic,
        );
      }
    }
  }

  return registry;
}

export function evaluateLocalModStatuses(
  registry: LocalModRegistry | null,
  context: ModContext,
): Record<string, string> {
  if (!registry) return {};

  const statuses: Record<string, string> = {};
  for (const [key, value] of Object.entries(registry.ui.statusValues)) {
    try {
      const nextValue =
        typeof value === "function"
          ? value(
              attachDeprecatedGetContextTrap(
                { ...context },
                registry.ui.statusRecorders[key],
                "ctx.getContext",
              ),
            )
          : value;
      if (nextValue != null) {
        statuses[key] = nextValue;
      }
    } catch (error) {
      registry.ui.statusRecorders[key]?.({
        capability: { id: key, kind: "status" },
        error: error instanceof Error ? error : new Error(String(error)),
        phase: "status.evaluate",
      });
      // Status providers run during render; failed providers are skipped so the
      // mod cannot crash the TUI.
    }
  }

  return statuses;
}

export async function emitLocalModEvent<TName extends ModEventName>(
  registry: LocalModRegistry | null,
  name: TName,
  event: ModEventMap[TName],
  context: ModContext,
  backend?: Backend,
  onDiagnostic?: (diagnostic: ModDiagnostic) => void,
): Promise<ModEventEmissionResult<TName>> {
  if (!registry) {
    return { diagnostics: [], handlerCount: 0, name, results: [] };
  }

  validateModEventName(name);
  const registrations = [...(registry.events[name] ?? [])];
  const diagnostics: ModDiagnostic[] = [];
  const results: Array<NonNullable<ModEventResultMap[TName]>> = [];

  for (const registration of registrations) {
    const signal = registration.owner
      ? registry.ownerAbortControllers[registration.owner.id]?.signal
      : undefined;
    if (signal?.aborted) continue;
    const turnStartEvent =
      name === "turn_start" ? (event as ModTurnStartEvent) : null;
    const turnStartInputBeforeHandler =
      turnStartEvent && isTurnStartInput(turnStartEvent.input)
        ? cloneTurnStartInput(turnStartEvent.input)
        : null;
    const toolStartEvent =
      name === "tool_start" ? (event as ModToolStartEvent) : null;
    const toolStartArgsBeforeHandler =
      toolStartEvent && isToolStartArgs(toolStartEvent.args)
        ? cloneToolStartArgs(toolStartEvent.args)
        : null;

    try {
      const recordEventDiagnostic = (
        diagnostic: Pick<
          ModDiagnostic,
          "capability" | "error" | "phase" | "severity"
        >,
      ): void => {
        recordModDiagnostic(
          registry,
          {
            ...diagnostic,
            owner: registration.owner,
          },
          onDiagnostic,
        );
      };
      const eventContext: ModEventContext = attachDeprecatedGetContextTrap(
        {
          ...context,
          conversation: createModConversationHandle({
            agentId:
              typeof event.agentId === "string"
                ? event.agentId
                : context.agent.id,
            backend,
            conversationId:
              typeof event.conversationId === "string"
                ? event.conversationId
                : context.sessionId,
            sendMessageStream: sendMessageStreamWithBackend,
            workingDirectory: context.cwd,
          }),
          signal: signal ?? new AbortController().signal,
        },
        recordEventDiagnostic,
        "ctx.getContext",
      );
      const result = await registration.handler(event, eventContext);
      if (isTurnStartResultWithInput(name, result)) {
        (event as ModTurnStartEvent).input = result.input;
      }
      if (isToolStartResultWithArgs(name, result)) {
        (event as ModToolStartEvent).args = result.args;
      }
      if (result != null) {
        results.push(result as NonNullable<ModEventResultMap[TName]>);
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
      const diagnostic = recordModDiagnostic(
        registry,
        {
          capability: { id: name, kind: "event" },
          error: error instanceof Error ? error : new Error(String(error)),
          owner: registration.owner,
          phase: "event",
        },
        onDiagnostic,
      );
      diagnostics.push(diagnostic);
    }
  }

  return { diagnostics, handlerCount: registrations.length, name, results };
}

export function disposeLocalMods(registry: LocalModRegistry): void {
  for (const abortController of Object.values(registry.ownerAbortControllers)) {
    abortController.abort("mod disposed");
  }

  const disposers = [...registry.disposers].reverse();
  registry.disposers = [];

  for (const { dispose, owner } of disposers) {
    try {
      dispose();
    } catch (error) {
      recordModDiagnostic(registry, {
        error: error instanceof Error ? error : new Error(String(error)),
        owner,
        phase: "dispose",
      });
    }
  }

  for (const owner of Object.values(registry.owners)) {
    unregisterPiProvidersForOwner(owner.id);
    unregisterModPermissionsForOwner(owner);
    unregisterModToolsForOwner(owner);
  }
  clearAvailableModelsCache();

  registry.commands = {};
  registry.events = {};
  registry.ownerAbortControllers = {};
  registry.owners = {};
  registry.permissions = {};
  registry.tools = {};
  registry.ui.panels = {};
  registry.ui.statusOwners = {};
  registry.ui.statusRecorders = {};
  registry.ui.statusValues = {};
  registry.ui.statuslineRenderer = null;
  delete registry.ui.statuslineRecordDiagnostic;
  delete registry.ui.statuslineRendererOwner;
}

export function createModEngine(options: CreateModEngineOptions): ModEngine {
  const { getBackend, onDiagnostic, ...modOptions } = options;
  let generation = 0;
  let disposed = false;
  const capabilities = resolveModCapabilities(modOptions.capabilities);
  let activeRegistry = createEmptyModRegistry(
    resolveLocalModSources(modOptions),
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

    disposeLocalMods(activeRegistry);
    generation += 1;
    const loadGeneration = generation;
    activeRegistry = createEmptyModRegistry(
      resolveLocalModSources(modOptions),
      loadGeneration,
      capabilities,
    );
    publish();

    let loadingRegistry: LocalModRegistry | null = null;
    const nextRegistry = await loadLocalMods({
      ...modOptions,
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
          onDiagnostic?.(diagnostic);
          return;
        }
        // Stale handles from a prior generation report through their old
        // activation callback. Preserve the diagnostic on the current engine
        // snapshot without reviving the old registry.
        appendModDiagnostic(activeRegistry, diagnostic);
        publish();
        onDiagnostic?.(diagnostic);
      },
    });
    loadingRegistry = nextRegistry;
    if (disposed || loadGeneration !== generation) {
      disposeLocalMods(nextRegistry);
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
      disposeLocalMods(activeRegistry);
      activeRegistry = createEmptyModRegistry(
        resolveLocalModSources(modOptions),
        generation,
        capabilities,
      );
      publish();
      listeners.clear();
    },
    async emitEvent(name, payload, context) {
      if (disposed) {
        return { diagnostics: [], handlerCount: 0, name, results: [] };
      }
      const invocationBackend = getBackend?.();
      const result = await emitLocalModEvent(
        activeRegistry,
        name,
        payload,
        context,
        invocationBackend,
        onDiagnostic,
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
