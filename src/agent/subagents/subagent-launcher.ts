import { homedir } from "node:os";
import { join } from "node:path";
import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import { type BackendMode, getLocalBackendStorageDir } from "@/backend";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  LETTA_MOD_CAPABILITY_PROFILE_ENV,
  PROVIDERS_ONLY_MOD_CAPABILITY_PROFILE,
} from "@/mods/capabilities";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  resolveEntryScriptPath,
  resolveLettaInvocation,
} from "@/tools/impl/shell-env";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import {
  readSubagentDepth,
  SUBAGENT_DEPTH_ENV,
} from "@/utils/subagent-depth-env";
import {
  LISTENER_CONNECTION_ENV,
  SUBAGENT_LAUNCH_ENV,
  SUBAGENT_LAUNCH_PROFILE_ENV,
  SUBAGENT_NAME_ENV,
  SUBAGENT_SUMMARY_ENV,
} from "@/utils/subagent-launch-marker";
import { TRANSCRIPT_ROOT_ENV } from "@/utils/transcript-paths";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import type { SubagentLaunchProfile, SubagentMemoryScope } from ".";
import { MEMORY_WORKER_SESSION_ENV } from "./memory-worker-session";

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

  if (
    options.subagentType !== "reflection" &&
    options.launchProfile === "memory-subagent" &&
    options.memoryScope?.primaryRoot
  ) {
    return options.memoryScope.primaryRoot;
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

  if (currentScript.endsWith(".ts")) {
    return {
      command: execPath,
      args: [resolvedCurrentScript, ...cliArgs],
    };
  }

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
  parentProcessEnv: NodeJS.ProcessEnv;
  listenerConnectionId?: string | null;
  backendMode?: BackendMode;
  localBackendStorageDir?: string | null;
  parentAgentId: string | undefined;
  parentConversationId?: string;
  subagentType?: string;
  launchProfile: SubagentLaunchProfile | undefined;
  inheritedPrimaryRoot: string | null;
  memoryScope?: SubagentMemoryScope;
  inheritedApiKey?: string | null;
  inheritedBaseUrl?: string | null;
  actingUserId?: string | null;
  transcriptPath?: string | null;
  subagentName?: string;
  subagentSummary?: string;
  subagentId?: string;
}

function resolveMemorySubagentScratchpad(
  parentProcessEnv: NodeJS.ProcessEnv,
  subagentId?: string,
): string {
  const configuredScratchpad = parentProcessEnv.LETTA_SCRATCHPAD;
  if (configuredScratchpad?.trim()) {
    return configuredScratchpad;
  }

  const configuredTranscriptRoot = parentProcessEnv[TRANSCRIPT_ROOT_ENV];
  const transcriptRoot =
    configuredTranscriptRoot?.trim() ||
    join(resolveGlobalConfigDir(parentProcessEnv, homedir()), "transcripts");
  const scope = subagentId
    ? encodeURIComponent(subagentId)
    : crypto.randomUUID();
  return join(transcriptRoot, "background", scope);
}

export function composeSubagentChildEnv(
  options: ComposeSubagentChildEnvOptions,
): NodeJS.ProcessEnv {
  const {
    parentProcessEnv,
    listenerConnectionId,
    backendMode,
    localBackendStorageDir,
    parentAgentId,
    subagentType,
    launchProfile,
    inheritedPrimaryRoot,
    memoryScope,
    inheritedApiKey,
    inheritedBaseUrl,
    actingUserId,
    transcriptPath,
  } = options;

  const childEnv: NodeJS.ProcessEnv = {
    ...parentProcessEnv,
    ...(inheritedApiKey && { LETTA_API_KEY: inheritedApiKey }),
    ...(inheritedBaseUrl && { LETTA_BASE_URL: inheritedBaseUrl }),
    DISABLE_AUTOUPDATER: "1",
    LETTA_CODE_AGENT_ROLE: "subagent",
    [MEMORY_WORKER_SESSION_ENV]: subagentType === "memory" ? "1" : undefined,
    [SUBAGENT_LAUNCH_ENV]: "1",
    [SUBAGENT_LAUNCH_PROFILE_ENV]: launchProfile ?? "default",
    ...((subagentType === "reflection" || subagentType === "memory") && {
      [LETTA_MOD_CAPABILITY_PROFILE_ENV]: PROVIDERS_ONLY_MOD_CAPABILITY_PROFILE,
    }),
    LETTA_PARENT_AGENT_ID: parentAgentId,
    LETTA_PARENT_CONVERSATION_ID: options.parentConversationId,
    [SUBAGENT_SUMMARY_ENV]: options.subagentSummary,
    [SUBAGENT_DEPTH_ENV]: String(readSubagentDepth(parentProcessEnv) + 1),
    ...(transcriptPath && { TRANSCRIPT_PATH: transcriptPath }),
  };

  if (actingUserId) childEnv[ACTING_USER_ID_ENV] = actingUserId;
  else if (actingUserId === null) delete childEnv[ACTING_USER_ID_ENV];
  delete childEnv[SUBAGENT_NAME_ENV];
  if (options.subagentName) childEnv[SUBAGENT_NAME_ENV] = options.subagentName;

  if (backendMode === "local") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    if (localBackendStorageDir) {
      childEnv.LETTA_LOCAL_BACKEND_DIR = localBackendStorageDir;
    }
  } else if (backendMode === "api") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "0";
  }

  if (launchProfile === "memory-subagent") {
    delete childEnv[LISTENER_CONNECTION_ENV];
    childEnv.LETTA_SCRATCHPAD = resolveMemorySubagentScratchpad(
      parentProcessEnv,
      options.subagentId,
    );
    const primaryRoot = memoryScope?.primaryRoot ?? inheritedPrimaryRoot;
    if (primaryRoot) {
      childEnv.MEMORY_DIR = primaryRoot;
      childEnv.LETTA_MEMORY_DIR = primaryRoot;
    } else {
      delete childEnv.MEMORY_DIR;
      delete childEnv.LETTA_MEMORY_DIR;
    }
  } else if (listenerConnectionId?.startsWith("conn-")) {
    childEnv[LISTENER_CONNECTION_ENV] = listenerConnectionId;
  } else if (
    isUnattachedListenerLaunch({
      listenerConnectionId,
      launchProfile,
      listenerConnectionCount: getActiveRuntime()?.connections.size ?? 0,
    })
  ) {
    trackBoundaryError({
      errorType: "subagent_launch_missing_listener_connection",
      error: new Error(
        "Subagent launched in a listener without its connection",
      ),
      context: "subagent_launch",
    });
  }

  return childEnv;
}

export function isUnattachedListenerLaunch(options: {
  listenerConnectionId?: string | null;
  launchProfile?: string;
  listenerConnectionCount: number;
}): boolean {
  return (
    !options.listenerConnectionId &&
    options.launchProfile !== "memory-subagent" &&
    options.listenerConnectionCount > 0
  );
}

export function shouldLaunchThroughListener(options: {
  launchProfile?: string;
  cloudBackend: boolean;
  connectionId?: string;
  computer?: string;
  ephemeral?: boolean;
}): boolean {
  if (options.ephemeral) {
    if (options.computer)
      throw new Error(
        "Ephemeral conversations cannot be routed to a Cloud computer",
      );
    return false;
  }
  if (options.launchProfile === "memory-subagent") {
    if (options.computer)
      throw new Error(
        "Memory subagents must run in their confined local process, not through a computer listener",
      );
    return false;
  }
  return (
    Boolean(options.computer) ||
    (options.cloudBackend && Boolean(options.connectionId))
  );
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
