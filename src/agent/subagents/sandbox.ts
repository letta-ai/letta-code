import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendHarnessWritableRoots,
} from "@/backend/local/paths";
import { buildMemoryModeSandboxPolicy } from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";
import { getTranscriptRoot } from "@/utils/transcript-paths";

/**
 * Applies an OS-level filesystem sandbox to a subagent child process at spawn.
 *
 * Memory-mode subagents (reflection, memory, init, history-analyzer) operate on
 * their parent's memory as their working filesystem. Wrapping the whole child
 * process kernel-enforces "writes only to the memory dir" — covering its
 * in-process Write/Edit tools, its Bash commands, and anything those spawn — so
 * the static memory shell-scoping becomes redundant for these agents.
 *
 * Gated behind `LETTA_FS_SANDBOX=1` while the per-host bring-up is validated.
 *
 * Both backends write-scope the agent's work to memory (`restrictWrites:true`):
 * a memory subagent may write its memory but not the repo, home, or temp.
 *   - API/cloud: walls off `~/.letta/agents`; conversation/state persistence is
 *     server-side, so only memory (+ the transcript root) is writable.
 *   - Local: walls off `lc-local-backend/memfs` and additionally carves the
 *     backend's on-disk harness dirs (conversations/agents/providers) writable —
 *     the child runs the backend in-process and persists there, so without the
 *     carve write-scoping would trap it. Cross-agent memory stays read- and
 *     write-denied on both.
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
  if (!availability.backend) return null;

  // Writes are scoped to memory on both backends. Carve the harness-metadata
  // paths the child legitimately persists so write-scoping doesn't trap it: the
  // transcript root (both backends, written via the headless loop) and, on
  // local, the on-disk conversation/agent-state/auth dirs the in-process backend
  // writes (the API backend persists those server-side).
  const isLocal = input.backendMode === "local";
  const storageDir = input.localBackendStorageDir ?? undefined;
  const extraWritableRoots = [
    getTranscriptRoot(),
    ...(isLocal ? getLocalBackendHarnessWritableRoots(storageDir) : []),
  ];
  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: writableMemoryRoots,
    agentsTreeRoot: isLocal
      ? getLocalBackendCrossAgentTreeRoot(storageDir)
      : undefined,
    extraWritableRoots,
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
