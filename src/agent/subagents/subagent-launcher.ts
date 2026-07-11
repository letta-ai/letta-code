// How a subagent child process is launched: the command/args to spawn, the
// working directory it runs in, and the environment it inherits (including the
// memory-subagent MEMORY_DIR wiring and channel-context propagation).
//
// Extracted from `manager.ts`. Pure resolution helpers — they depend only on
// lower-level backend/runtime/shell helpers and shared subagent types, never
// back on the subagent manager, so the graph stays acyclic.

import { type BackendMode, getLocalBackendStorageDir } from "@/backend";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  getCurrentWorkingDirectory,
  type InheritedChannelContextPayload,
  LETTA_INHERITED_CHANNEL_CONTEXT_ENV,
  type RuntimeContextSnapshot,
} from "@/runtime-context";
import {
  resolveEntryScriptPath,
  resolveLettaInvocation,
} from "@/tools/impl/shell-env";
import type { SubagentLaunchProfile, SubagentMemoryScope } from ".";

interface ResolveSubagentLauncherOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
}

interface SubagentLauncher {
  command: string;
  args: string[];
}

export function resolveSubagentWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCwd: string = getCurrentWorkingDirectory(),
  options: {
    subagentType?: string;
    launchProfile?: SubagentLaunchProfile;
    inheritedPrimaryRoot?: string | null;
    memoryScope?: SubagentMemoryScope;
  } = {},
): string {
  if (
    options.subagentType === "reflection" &&
    options.launchProfile === "memory-subagent" &&
    options.memoryScope
  ) {
    return env.USER_CWD || fallbackCwd;
  }

  const primaryRoot =
    options.memoryScope?.primaryRoot ?? options.inheritedPrimaryRoot;
  if (
    options.subagentType === "reflection" &&
    options.launchProfile === "memory-subagent" &&
    primaryRoot
  ) {
    return primaryRoot;
  }

  return env.USER_CWD || fallbackCwd;
}

export function resolveSubagentLauncher(
  cliArgs: string[],
  options: ResolveSubagentLauncherOptions = {},
): SubagentLauncher {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();

  const invocation = resolveLettaInvocation(env, argv, execPath, cwd);
  if (invocation) {
    return {
      command: invocation.command,
      args: [...invocation.args, ...cliArgs],
    };
  }

  const currentScript = argv[1] || "";
  const resolvedCurrentScript = resolveEntryScriptPath(currentScript, cwd);

  // Preserve historical subagent behavior: any .ts entrypoint uses runtime binary.
  if (currentScript.endsWith(".ts")) {
    return {
      command: execPath,
      args: [resolvedCurrentScript, ...cliArgs],
    };
  }

  // Windows cannot reliably spawn bundled .js directly (EFTYPE/EINVAL).
  if (currentScript.endsWith(".js") && platform === "win32") {
    return {
      command: execPath,
      args: [resolvedCurrentScript, ...cliArgs],
    };
  }

  if (currentScript.endsWith(".js")) {
    return {
      command: resolvedCurrentScript,
      args: cliArgs,
    };
  }

  return {
    command: "letta",
    args: cliArgs,
  };
}

export interface ComposeSubagentChildEnvOptions {
  /** The env of the process spawning the subagent (parent). */
  parentProcessEnv: NodeJS.ProcessEnv;
  /** Active backend mode to force in the child CLI process. */
  backendMode?: BackendMode;
  /** Local backend flatfile root to forward when backendMode="local". */
  localBackendStorageDir?: string | null;
  /** Parent agent ID. When present, sets LETTA_PARENT_AGENT_ID so prompts,
   * scripts, and the cross-agent guard can identify the immediate parent. */
  parentAgentId: string | undefined;
  /** The subagent config's declared launch profile. Subagents with the memory-subagent profile
   * operate on the parent's memory filesystem. */
  launchProfile: SubagentLaunchProfile | undefined;
  /** Primary memory root for the parent, used by the memory-subagent launch
   * profile to point the child at its parent's memfs repo. Null means memfs
   * disabled or unresolvable — child operates without a MEMORY_DIR. */
  inheritedPrimaryRoot: string | null;
  /** Optional exact memory scope for harness-created worktrees. */
  memoryScope?: SubagentMemoryScope;
  /** Forwarded API key to avoid per-subagent keychain lookups. */
  inheritedApiKey?: string | null;
  /** Forwarded base URL to avoid per-subagent settings lookups. */
  inheritedBaseUrl?: string | null;
  /** Optional path to a transcript payload file, exposed to the child as
   * the TRANSCRIPT_PATH env var. Used by reflection subagents so the prompt
   * can reference `$TRANSCRIPT_PATH` (resolved via Bash) instead of
   * interpolating the absolute path. Unset → no TRANSCRIPT_PATH in child. */
  transcriptPath?: string | null;
  /** Serializable channel scope for child processes. Execution-context IDs are
   * process-local, so channel scope must be copied explicitly across spawn. */
  inheritedChannelContext?: InheritedChannelContextPayload | null;
}

export function buildInheritedChannelContextPayload(
  runtimeContext: RuntimeContextSnapshot | undefined,
): InheritedChannelContextPayload | null {
  const channelToolScope = runtimeContext?.channelToolScope;
  const channelTurnSources = runtimeContext?.channelTurnSources ?? [];
  if (!channelToolScope?.channels.length && channelTurnSources.length === 0) {
    return null;
  }

  return {
    ...(channelToolScope?.channels.length ? { channelToolScope } : {}),
    ...(channelTurnSources.length
      ? { channelTurnSources: [...channelTurnSources] }
      : {}),
  };
}

/**
 * Compose the env a subagent child process should be spawned with.
 *
 * The parent identity marker and filesystem pointer are intentionally
 * decoupled:
 *
 *   - LETTA_PARENT_AGENT_ID identifies the immediate parent. Subagents never
 *     inherit a broad cross-agent memory-guard opt-out from the parent.
 *
 *   - MEMORY_DIR / LETTA_MEMORY_DIR are only overridden when the subagent
 *     declares the memory-subagent launch profile. Those subagents operate on
 *     the parent's memory as their working filesystem (reflection, memory,
 *     init, history-analyzer). Other subagents keep whatever MEMORY_DIR they
 *     inherited from the parent process (usually unset).
 *
 * Pure function, no side effects — straightforward to unit-test.
 */
export function composeSubagentChildEnv(
  options: ComposeSubagentChildEnvOptions,
): NodeJS.ProcessEnv {
  const {
    parentProcessEnv,
    backendMode,
    localBackendStorageDir,
    parentAgentId,
    launchProfile,
    inheritedPrimaryRoot,
    memoryScope,
    inheritedApiKey,
    inheritedBaseUrl,
    transcriptPath,
    inheritedChannelContext,
  } = options;

  const childEnv: NodeJS.ProcessEnv = {
    ...parentProcessEnv,
    ...(inheritedApiKey && { LETTA_API_KEY: inheritedApiKey }),
    ...(inheritedBaseUrl && { LETTA_BASE_URL: inheritedBaseUrl }),
    LETTA_CODE_AGENT_ROLE: "subagent",
    ...(parentAgentId && { LETTA_PARENT_AGENT_ID: parentAgentId }),
    ...(transcriptPath && { TRANSCRIPT_PATH: transcriptPath }),
    ...(inheritedChannelContext && {
      [LETTA_INHERITED_CHANNEL_CONTEXT_ENV]: JSON.stringify(
        inheritedChannelContext,
      ),
    }),
  };

  if (backendMode === "local") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    if (localBackendStorageDir) {
      childEnv.LETTA_LOCAL_BACKEND_DIR = localBackendStorageDir;
    }
  } else if (backendMode === "api") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "0";
  }

  // Only subagents with the memory-subagent profile get MEMORY_DIR pointed at the parent. Other
  // subagents either have their own memfs (if memfs-enabled) or no MEMORY_DIR
  // at all — their tools will surface resolution errors appropriately.
  if (launchProfile === "memory-subagent") {
    const primaryRoot = memoryScope?.primaryRoot ?? inheritedPrimaryRoot;
    if (primaryRoot) {
      childEnv.MEMORY_DIR = primaryRoot;
      childEnv.LETTA_MEMORY_DIR = primaryRoot;
    } else {
      delete childEnv.MEMORY_DIR;
      delete childEnv.LETTA_MEMORY_DIR;
    }
  }

  return childEnv;
}

export function resolveSubagentInheritedPrimaryRoot(options: {
  backendMode: BackendMode;
  parentAgentId: string | undefined;
  inheritedPrimaryRoot: string | null;
  localBackendStorageDir?: string | null;
}): string | null {
  if (options.backendMode === "local" && options.parentAgentId) {
    return getLocalBackendMemoryFilesystemRoot(
      options.parentAgentId,
      options.localBackendStorageDir ?? getLocalBackendStorageDir(),
    );
  }
  return options.inheritedPrimaryRoot;
}
