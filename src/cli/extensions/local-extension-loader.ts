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
import type {
  StatuslineRenderContext,
  StatuslineRenderer,
  StatuslineRendererOutput,
} from "@/cli/display/statusline/types";

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
const requireFromRuntime = createRequire(import.meta.url);

export type StatuslineRenderFunction = (
  context: StatuslineRenderContext,
) => StatuslineRendererOutput;

// First extension surface is statusline rendering, so the shared extension
// context is currently the statusline render context. When we add non-UI
// surfaces like commands, split this into a generic ExtensionContext base and
// let StatuslineRenderContext extend it.
export type ExtensionContext = StatuslineRenderContext;

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
  getContext: () => ExtensionContext;
  ui: {
    clearStatus: (key: string) => void;
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
  statuslineRenderer: StatuslineRenderer | null;
  statusValues: Record<string, ExtensionStatusValue>;
}

export interface LocalExtensionRegistry {
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
  onChange?: () => void;
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

function createImportableExtensionPath(
  extensionPath: string,
  cacheDirectory: string,
): string {
  ensureExtensionCache(cacheDirectory);

  const source = readFileSync(extensionPath, "utf8");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const extension = path.extname(extensionPath);
  const baseName = path
    .basename(extensionPath, extension)
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const importPath = path.join(
    cacheDirectory,
    `.letta-extension-${baseName}-${hash}${extension}`,
  );

  if (!existsSync(importPath)) {
    writeFileSync(importPath, source, "utf8");
  }

  try {
    for (const entry of readdirSync(cacheDirectory)) {
      if (
        entry.startsWith(`.letta-extension-${baseName}-`) &&
        entry.endsWith(extension) &&
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

function createLettaExtensionApi(
  registry: LocalExtensionRegistry,
  extensionPath: string,
  getContext: () => ExtensionContext,
  onChange: () => void,
): LettaExtensionApi {
  return {
    getContext,
    ui: {
      clearStatus(key) {
        delete registry.ui.statusValues[key];
        onChange();
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
  options: LoadLocalExtensionsOptions = {},
): Promise<LocalExtensionRegistry> {
  const cacheDirectory = options.cacheDirectory ?? EXTENSION_CACHE_DIRECTORY;
  const getContext =
    options.getContext ??
    (() => {
      throw new Error("Extension context is not available yet");
    });
  const onChange = options.onChange ?? (() => {});
  const sources = resolveLocalExtensionSources(options);
  const registry: LocalExtensionRegistry = {
    disposers: [],
    errors: [],
    loadedPaths: [],
    sources,
    ui: {
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
        createLettaExtensionApi(registry, extensionPath, getContext, onChange),
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

  registry.ui.statusValues = {};
  registry.ui.statuslineRenderer = null;
}
