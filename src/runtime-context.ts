import { AsyncLocalStorage } from "node:async_hooks";
import { homedir, tmpdir } from "node:os";
import { resolveActingUserId } from "@/agent/acting-user";
import type { SkillSource } from "./agent/skills";
import { isUsableDirectory } from "./helpers/usable-directory";
import type { RuntimeExecutionSettings } from "./runtime-execution-settings";
import type { GitAttribution } from "./types/git-attribution";

export type RuntimeSessionSource = "interactive-cli" | "headless" | "listen";

export type RuntimePermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted"
  | "strict";

export interface RuntimeWorkspaceSandbox {
  root: string;
  isolationRoot: string;
}

export interface RuntimeContextSnapshot {
  turnStartedAt?: number;
  sessionSource?: RuntimeSessionSource;
  connectionId?: string | null;
  environmentDeviceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  conversationId?: string | null;
  gitAttribution?: GitAttribution;
  actingUserId?: string;
  mcpOriginatorSuperRunId?: string | null;
  resolveMcpOriginatorSuperRunId?: () => string | null | undefined;
  resolveClientMessageIds?: () => string[];
  suppressActingUserFallback?: boolean;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  bundledSkills?: string[];
  workingDirectory?: string | null;
  workingDirectoryRecoveredFrom?: string | null;
  toolContextId?: string | null;
  clientToolNames?: string[];
  permissionMode?: RuntimePermissionMode;
  workspaceSandbox?: RuntimeWorkspaceSandbox;
  executionSettings?: RuntimeExecutionSettings;
  foregroundYieldMs?: number;
}

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContextSnapshot>();

export function getRuntimeContext(): RuntimeContextSnapshot | undefined {
  return runtimeContextStorage.getStore();
}

export function getRuntimeSessionSource(): RuntimeSessionSource | undefined {
  const source =
    getRuntimeContext()?.sessionSource ??
    process.env.LETTA_RUNTIME_SESSION_SOURCE;
  return source === "interactive-cli" ||
    source === "headless" ||
    source === "listen"
    ? source
    : undefined;
}

export function getRuntimeActingUserId(): string | undefined {
  const context = getRuntimeContext();
  if (context?.suppressActingUserFallback) return undefined;
  return resolveActingUserId(undefined, context?.actingUserId);
}

export function getRuntimeActingUserAttribution(): string | null | undefined {
  if (getRuntimeContext()?.suppressActingUserFallback) return null;
  return getRuntimeActingUserId();
}

/** Copy attribution into this process launch without mutating the listener environment. */
export function applyTurnGitAttribution(env: NodeJS.ProcessEnv): void {
  const attribution = getRuntimeContext()?.gitAttribution;
  if (attribution) {
    env.LETTA_GIT_REQUESTER = attribution.requester;
    env.LETTA_GIT_CONVERSATION = attribution.conversation;
  } else {
    delete env.LETTA_GIT_REQUESTER;
    delete env.LETTA_GIT_CONVERSATION;
  }
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
  );
}

function getProcessWorkingDirectory(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

export function getFallbackWorkingDirectory(): string {
  const fallback = [
    process.env.USER_CWD,
    getProcessWorkingDirectory(),
    homedir(),
    tmpdir(),
    process.platform === "win32" ? undefined : "/",
  ].find(isUsableDirectory);

  if (fallback) {
    return fallback;
  }

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
    updateRuntimeContext({
      workingDirectory: fallback,
      workingDirectoryRecoveredFrom: workingDirectory,
    });
  }

  return fallback;
}

export function consumeWorkingDirectoryRecovery(): string | null {
  const runtimeContext = runtimeContextStorage.getStore();
  const recoveredFrom = runtimeContext?.workingDirectoryRecoveredFrom;
  if (!runtimeContext || !recoveredFrom) {
    return null;
  }
  runtimeContext.workingDirectoryRecoveredFrom = null;
  return recoveredFrom;
}
