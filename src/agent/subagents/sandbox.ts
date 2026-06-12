import { getLocalBackendCrossAgentTreeRoot } from "@/backend/local/paths";
import { buildMemoryModeSandboxPolicy } from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
  warnSandboxBackendUnavailable,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";
import { getTranscriptRoot } from "@/utils/transcript-paths";

/**
 * Applies an OS-level filesystem sandbox to a subagent child process at spawn.
 *
 * Memory-mode subagents (reflection, memory, init, history-analyzer) operate on
 * their parent's memory as their working filesystem. Wrapping the whole child
 * process kernel-enforces the write scope — covering its in-process Write/Edit
 * tools, its Bash commands, and anything those spawn — so the static memory
 * shell-scoping becomes redundant for these agents.
 *
 * Enabled by default; set `LETTA_FS_SANDBOX=0` to opt out. No-ops when the host
 * has no sandbox backend.
 *
 * Both backends scope writes to the harness state dir (`~/.letta`): a memory
 * subagent may persist memory + harness metadata (settings, logs, conversations,
 * transcripts) but not the repo, home, or temp. The cross-agent tree nested
 * inside `~/.letta` stays read- and write-denied (`~/.letta/agents` on API,
 * `lc-local-backend/memfs` on local); self memory is re-carved writable. Carving
 * the whole `~/.letta` rather than each harness file avoids silently breaking
 * harness writes (settings, etc.) as new writers appear under it.
 */

interface SubagentLauncher {
  command: string;
  args: string[];
}

export interface WrapSubagentLauncherInput {
  launcher: SubagentLauncher;
  /** The subagent's declared permission mode; only "memory" is wrapped. */
  permissionMode: string | undefined;
  /** Active backend; selects the tree + write posture ("local" vs "api"). */
  backendMode: string;
  /** Resolved memory roots the child may write to (MEMORY_DIR + siblings). */
  memoryRoots: string[];
  /** MEMORY_DIR target; folded into the writable set if not already present. */
  inheritedPrimaryRoot: string | null;
  /**
   * Local backend storage dir (`~/.letta/lc-local-backend`), used to locate the
   * `memfs` cross-agent tree. Only consulted when `backendMode === "local"`;
   * null/omitted falls back to the default storage dir.
   */
  localBackendStorageDir?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to a real host probe. */
  availability?: SandboxAvailability;
}

export interface WrapSubagentLauncherResult {
  command: string;
  args: string[];
  /** Env additions to merge into the child env (the sandbox sentinel). */
  sandboxEnv: Record<string, string>;
  backend: SandboxBackend;
}

/**
 * Wrap a subagent launcher under a memory-mode sandbox, or return null to spawn
 * it unchanged (flag off, not memory mode, no backend on host, or nothing to
 * restrict).
 */
export function wrapSubagentLauncher(
  input: WrapSubagentLauncherInput,
): WrapSubagentLauncherResult | null {
  const env = input.env ?? process.env;

  if (!isFsSandboxEnabled(env)) return null;
  if (input.permissionMode !== "memory") return null;

  const writableMemoryRoots = [...input.memoryRoots];
  if (
    input.inheritedPrimaryRoot &&
    !writableMemoryRoots.includes(input.inheritedPrimaryRoot)
  ) {
    writableMemoryRoots.push(input.inheritedPrimaryRoot);
  }
  // Nothing to scope to → don't sandbox (avoid trapping the child with no
  // writable memory dir at all).
  if (writableMemoryRoots.length === 0) return null;

  const availability = input.availability ?? detectSandboxBackend();
  if (!availability.backend) {
    warnSandboxBackendUnavailable(availability, "memory-mode subagent sandbox");
    return null;
  }

  // Writes are scoped to the harness state dir (~/.letta) by the policy: the
  // child can persist memory + harness metadata (settings, logs, conversations,
  // transcripts) but not the repo/home/temp. Pass any harness root configured
  // OUTSIDE ~/.letta — a custom transcript root, or a relocated local storage
  // dir — so those stay writable too (defaults already live under ~/.letta).
  const isLocal = input.backendMode === "local";
  const storageDir = input.localBackendStorageDir ?? undefined;
  const harnessWritableRoots = [
    getTranscriptRoot(),
    ...(isLocal && storageDir ? [storageDir] : []),
  ];
  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: writableMemoryRoots,
    agentsTreeRoot: isLocal
      ? getLocalBackendCrossAgentTreeRoot(storageDir)
      : undefined,
    harnessWritableRoots,
  });

  const wrapped = wrapLauncher(
    [input.launcher.command, ...input.launcher.args],
    policy,
    { backend: availability.backend, bwrapPath: availability.bwrapPath },
  );
  if (!wrapped || wrapped.length === 0) return null;

  const [command, ...args] = wrapped;
  return {
    command: command as string,
    args,
    sandboxEnv: { [SANDBOX_ENV_VAR]: availability.backend },
    backend: availability.backend,
  };
}
