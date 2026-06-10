import { buildMemoryModeSandboxPolicy } from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

/**
 * Applies an OS-level filesystem sandbox to a subagent child process at spawn.
 *
 * Memory-mode subagents (reflection, memory, init, history-analyzer) operate on
 * their parent's memory as their working filesystem. Wrapping the whole child
 * process kernel-enforces "writes only to the memory dir" — covering its
 * in-process Write/Edit tools, its Bash commands, and anything those spawn — so
 * the static memory shell-scoping becomes redundant for these agents.
 *
 * Gated behind `LETTA_FS_SANDBOX=1` while the per-host bring-up is validated,
 * and currently API-backend only: the local backend stores conversation state
 * and per-agent memory under one tree, which needs its own policy split before
 * it can be safely write-restricted.
 */

interface SubagentLauncher {
  command: string;
  args: string[];
}

export interface WrapSubagentLauncherInput {
  launcher: SubagentLauncher;
  /** The subagent's declared permission mode; only "memory" is wrapped. */
  permissionMode: string | undefined;
  /** Active backend ("local" is skipped for now). */
  backendMode: string;
  /** Resolved memory roots the child may write to (MEMORY_DIR + siblings). */
  memoryRoots: string[];
  /** MEMORY_DIR target; folded into the writable set if not already present. */
  inheritedPrimaryRoot: string | null;
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
 * it unchanged (flag off, not memory mode, local backend, no backend on host,
 * or nothing to restrict).
 */
export function wrapSubagentLauncher(
  input: WrapSubagentLauncherInput,
): WrapSubagentLauncherResult | null {
  const env = input.env ?? process.env;

  if (!isFsSandboxEnabled(env)) return null;
  if (input.permissionMode !== "memory") return null;
  if (input.backendMode === "local") return null;

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

  const policy = buildMemoryModeSandboxPolicy({
    memoryRoots: writableMemoryRoots,
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
