import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { SkillSource } from "./agent/skills";
import type { MessageChannelToolDiscoveryScope } from "./channels/message-tool";
import type { ChannelTurnSource } from "./channels/types";

export type RuntimePermissionMode = "standard" | "acceptEdits" | "unrestricted";

export interface RuntimeContextSnapshot {
  agentId?: string | null;
  agentName?: string | null;
  conversationId?: string | null;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  workingDirectory?: string | null;
  toolContextId?: string | null;
  permissionMode?: RuntimePermissionMode;
  channelToolScope?: MessageChannelToolDiscoveryScope | null;
  channelTurnSources?: ChannelTurnSource[];
}

export interface InheritedChannelContextPayload {
  channelToolScope?: MessageChannelToolDiscoveryScope | null;
  channelTurnSources?: ChannelTurnSource[];
}

export const LETTA_INHERITED_CHANNEL_CONTEXT_ENV =
  "LETTA_INHERITED_CHANNEL_CONTEXT";

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContextSnapshot>();

export function getRuntimeContext(): RuntimeContextSnapshot | undefined {
  return runtimeContextStorage.getStore();
}

export function runWithRuntimeContext<T>(
  snapshot: RuntimeContextSnapshot,
  fn: () => T,
): T {
  const parent = runtimeContextStorage.getStore();
  return runtimeContextStorage.run(
    {
      ...parent,
      ...snapshot,
      ...(snapshot.skillSources
        ? { skillSources: [...snapshot.skillSources] }
        : {}),
      ...(snapshot.channelTurnSources
        ? { channelTurnSources: [...snapshot.channelTurnSources] }
        : {}),
    },
    fn,
  );
}

export function runOutsideRuntimeContext<T>(fn: () => T): T {
  return runtimeContextStorage.exit(fn);
}

export function updateRuntimeContext(
  update: Partial<RuntimeContextSnapshot>,
): void {
  const current = runtimeContextStorage.getStore();
  if (!current) {
    return;
  }

  Object.assign(
    current,
    update,
    update.skillSources && {
      skillSources: [...update.skillSources],
    },
    update.channelTurnSources && {
      channelTurnSources: [...update.channelTurnSources],
    },
  );
}

function isUsableDirectory(dirPath: string | null | undefined): boolean {
  if (typeof dirPath !== "string" || dirPath.length === 0) {
    return false;
  }

  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function getProcessWorkingDirectory(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function getFallbackWorkingDirectory(): string {
  const fallback = [
    process.env.USER_CWD,
    getProcessWorkingDirectory(),
    homedir(),
    process.platform === "win32" ? undefined : "/",
  ].find(isUsableDirectory);

  if (fallback) {
    return fallback;
  }

  // Extremely defensive fallback for pathological environments where every
  // candidate disappeared. The caller will still surface a clear cwd error.
  return process.platform === "win32" ? "C:\\" : "/";
}

export function getCurrentWorkingDirectory(): string {
  const runtimeContext = runtimeContextStorage.getStore();
  const workingDirectory = runtimeContext?.workingDirectory;
  if (
    typeof workingDirectory === "string" &&
    isUsableDirectory(workingDirectory)
  ) {
    return workingDirectory;
  }

  const fallback = getFallbackWorkingDirectory();
  if (
    runtimeContext &&
    typeof workingDirectory === "string" &&
    workingDirectory.length > 0 &&
    workingDirectory !== fallback
  ) {
    runtimeContext.workingDirectory = fallback;
  }

  return fallback;
}
