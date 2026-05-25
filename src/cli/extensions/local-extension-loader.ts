import { commands as builtinCommands } from "@/cli/commands/registry";
import type {
  CreateExtensionHostOptions,
  LoadLocalExtensionsOptions,
} from "@/extensions/extension-host";
import {
  createExtensionHost as createExtensionHostBase,
  disposeLocalExtensions,
  EXTENSION_CACHE_DIRECTORY,
  evaluateLocalExtensionStatuses,
  GLOBAL_EXTENSIONS_DIRECTORY,
  loadLocalExtensions as loadLocalExtensionsBase,
  resolveLocalExtensionSources,
} from "@/extensions/extension-host";
import { getAllLettaToolNames, getServerToolName } from "@/tools/manager";

function stripSlash(command: string): string {
  return command.startsWith("/") ? command.slice(1) : command;
}

function getDefaultReservedCommandIds(): Set<string> {
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
    reservedCommandIds?: Iterable<string>;
    reservedToolNames?: Iterable<string>;
  },
>(options: T): T {
  return {
    ...options,
    reservedCommandIds: [
      ...getDefaultReservedCommandIds(),
      ...(options.reservedCommandIds ?? []),
    ],
    reservedToolNames: [
      ...getDefaultReservedToolNames(),
      ...(options.reservedToolNames ?? []),
    ],
  };
}

export function createExtensionHost(options: CreateExtensionHostOptions) {
  return createExtensionHostBase(withDefaultReservations(options));
}

export function loadLocalExtensions(options: LoadLocalExtensionsOptions) {
  return loadLocalExtensionsBase(withDefaultReservations(options));
}

export {
  EXTENSION_CACHE_DIRECTORY,
  GLOBAL_EXTENSIONS_DIRECTORY,
  disposeLocalExtensions,
  evaluateLocalExtensionStatuses,
  resolveLocalExtensionSources,
};

export type {
  CreateExtensionHostOptions,
  ExtensionHost,
  ExtensionStatusValue,
  LettaExtensionApi,
  LettaExtensionDisposer,
  LettaExtensionFactory,
  LoadLocalExtensionsOptions,
  LocalExtensionDisposer,
  LocalExtensionLoadError,
  LocalExtensionRegistry,
  LocalExtensionSource,
  LocalExtensionUiRegistry,
  ResolveLocalExtensionSourcesOptions,
  StatuslineRenderFunction,
} from "@/extensions/extension-host";
