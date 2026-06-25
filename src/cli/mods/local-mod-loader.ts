import { commands as builtinCommands } from "@/cli/commands/registry";
import type { CreateModAdapterOptions } from "@/mods/mod-adapter";
import { createModAdapter as createModAdapterBase } from "@/mods/mod-adapter";
import type {
  CreateModEngineOptions,
  LoadLocalModsOptions,
} from "@/mods/mod-engine";
import {
  createModEngine as createModEngineBase,
  disposeLocalMods,
  emitLocalModEvent,
  GLOBAL_MODS_DIRECTORY,
  loadLocalMods as loadLocalModsBase,
  MOD_CACHE_DIRECTORY,
  resolveLocalModSources,
} from "@/mods/mod-engine";
import type { ModCapabilities } from "@/mods/types";
import { getAllLettaToolNames, getServerToolName } from "@/tools/manager";
import { TUI_MOD_CAPABILITIES } from "./capabilities";

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
    capabilities?: ModCapabilities;
    reservedToolNames?: Iterable<string>;
  },
>(options: T): T {
  return {
    ...options,
    builtinCommandIds: [
      ...getDefaultBuiltinCommandIds(),
      ...(options.builtinCommandIds ?? []),
    ],
    capabilities: options.capabilities ?? TUI_MOD_CAPABILITIES,
    reservedToolNames: [
      ...getDefaultReservedToolNames(),
      ...(options.reservedToolNames ?? []),
    ],
  };
}

export function createModEngine(options: CreateModEngineOptions) {
  return createModEngineBase(withDefaultReservations(options));
}

export function createModAdapter(options: CreateModAdapterOptions) {
  return createModAdapterBase(withDefaultReservations(options));
}

export function loadLocalMods(options: LoadLocalModsOptions) {
  return loadLocalModsBase(withDefaultReservations(options));
}

export {
  MOD_CACHE_DIRECTORY,
  GLOBAL_MODS_DIRECTORY,
  disposeLocalMods,
  emitLocalModEvent,
  resolveLocalModSources,
};

export type {
  CreateModAdapterOptions,
  ModAdapter,
  ModAdapterLoadState,
  ModAdapterSnapshot,
} from "@/mods/mod-adapter";
export type {
  CreateModEngineOptions,
  LettaModApi,
  LettaModDisposer,
  LettaModFactory,
  LoadLocalModsOptions,
  LocalModDisposer,
  LocalModRegistry,
  LocalModSource,
  LocalModUiRegistry,
  ModEngine,
  ResolveLocalModSourcesOptions,
} from "@/mods/mod-engine";
export { TUI_MOD_CAPABILITIES } from "./capabilities";
