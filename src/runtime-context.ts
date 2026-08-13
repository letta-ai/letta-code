import { AsyncLocalStorage } from "node:async_hooks";
import { homedir, tmpdir } from "node:os";
import type { SkillSource } from "./agent/skills";
import { isUsableDirectory } from "./helpers/usable-directory";

export type RuntimePermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted"
  | "strict";

export interface RuntimeWorkspaceSandbox {
  /** Runtime-owned writable workspace. */
  root: string;
  /** Parent tree whose peer workspaces must stay hidden. */
  isolationRoot: string;
}

export interface RuntimeContextSnapshot {
  /** Listener transport connection that owns the current turn, when present. */
  connectionId?: string | null;
  /** Registered listener device that owns the current turn, when present. */
  environmentDeviceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  conversationId?: string | null;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  workingDirectory?: string | null;
  /**
   * Set when the runtime-scoped working directory was found deleted and
   * repaired to a fallback mid-turn. Holds the original (now missing) path
   * until a shell tool consumes it to surface a note to the model.
   */
  workingDirectoryRecoveredFrom?: string | null;
  toolContextId?: string | null;
  permissionMode?: RuntimePermissionMode;
  workspaceSandbox?: RuntimeWorkspaceSandbox;
}

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
    updateRuntimeContext({
      workingDirectory: fallback,
      workingDirectoryRecoveredFrom: workingDirectory,
    });
  }

  return fallback;
}

/**
 * Returns (and clears) the original path of a working directory that was
 * repaired mid-turn because it no longer existed, or null when no recovery
 * happened. Shell tools use this to tell the model its cwd changed.
 */
export function consumeWorkingDirectoryRecovery(): string | null {
  const runtimeContext = runtimeContextStorage.getStore();
  const recoveredFrom = runtimeContext?.workingDirectoryRecoveredFrom;
  if (!runtimeContext || !recoveredFrom) {
    return null;
  }
  runtimeContext.workingDirectoryRecoveredFrom = null;
  return recoveredFrom;
}
