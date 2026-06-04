import { commands as builtinCommands } from "@/cli/commands/registry";
import type { CreateExtensionAdapterOptions } from "@/extensions/extension-adapter";
import { createExtensionAdapter as createExtensionAdapterBase } from "@/extensions/extension-adapter";
import type {
  CreateExtensionEngineOptions,
  LoadLocalExtensionsOptions,
} from "@/extensions/extension-engine";
import {
  createExtensionEngine as createExtensionEngineBase,
  disposeLocalExtensions,
  EXTENSION_CACHE_DIRECTORY,
  emitLocalExtensionEvent,
  evaluateLocalExtensionStatuses,
  GLOBAL_EXTENSIONS_DIRECTORY,
  loadLocalExtensions as loadLocalExtensionsBase,
  resolveLocalExtensionSources,
} from "@/extensions/extension-engine";
import type { ExtensionCapabilities } from "@/extensions/types";
import { getAllLettaToolNames, getServerToolName } from "@/tools/manager";
import { TUI_EXTENSION_CAPABILITIES } from "./capabilities";

function stripSlash(command: string): string {
  return command.startsWith("/") ? command.slice(1) : command;
}

function getDefaultBuiltinCommandIds(): Set<string> {
  return new Set(Object.keys(builtinCommands).map(stripSlash));
}

function getDefaultReservedToolNames(): Set<string> {
  const reserved = new Set<string>();
  for (const toolName of getAllLettaToolNames()) {
    reserved.add(toolName);
    reserved.add(getServerToolName(toolName));
  }
  return reserved;
}

function withDefaultReservations<
  T extends {
    builtinCommandIds?: Iterable<string>;
    capabilities?: ExtensionCapabilities;
    reservedToolNames?: Iterable<string>;
  },
>(options: T): T {
  return {
    ...options,
    builtinCommandIds: [
      ...getDefaultBuiltinCommandIds(),
      ...(options.builtinCommandIds ?? []),
    ],
    capabilities: options.capabilities ?? TUI_EXTENSION_CAPABILITIES,
    reservedToolNames: [
      ...getDefaultReservedToolNames(),
      ...(options.reservedToolNames ?? []),
    ],
  };
}

export function createExtensionEngine(options: CreateExtensionEngineOptions) {
  return createExtensionEngineBase(withDefaultReservations(options));
}

export function createExtensionAdapter(options: CreateExtensionAdapterOptions) {
  return createExtensionAdapterBase(withDefaultReservations(options));
}

export function loadLocalExtensions(options: LoadLocalExtensionsOptions) {
  return loadLocalExtensionsBase(withDefaultReservations(options));
}

export {
  EXTENSION_CACHE_DIRECTORY,
  GLOBAL_EXTENSIONS_DIRECTORY,
  disposeLocalExtensions,
  emitLocalExtensionEvent,
  evaluateLocalExtensionStatuses,
  resolveLocalExtensionSources,
};

export type {
  CreateExtensionAdapterOptions,
  ExtensionAdapter,
  ExtensionAdapterLoadState,
  ExtensionAdapterSnapshot,
} from "@/extensions/extension-adapter";
export type {
  CreateExtensionEngineOptions,
  ExtensionEngine,
  ExtensionStatusValue,
  LettaExtensionApi,
  LettaExtensionDisposer,
  LettaExtensionFactory,
  LoadLocalExtensionsOptions,
  LocalExtensionDisposer,
  LocalExtensionRegistry,
  LocalExtensionSource,
  LocalExtensionUiRegistry,
  ResolveLocalExtensionSourcesOptions,
  StatuslineRenderFunction,
} from "@/extensions/extension-engine";
export { TUI_EXTENSION_CAPABILITIES } from "./capabilities";
