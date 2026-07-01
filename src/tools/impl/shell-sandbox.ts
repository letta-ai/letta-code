import { resolveShellSandboxContext } from "@/permissions/sandbox-gate";
import {
  buildCrossAgentSandboxPolicy,
  deriveSelfAgentRootsForTrees,
} from "@/permissions/sandbox-policy";
import type { SandboxAvailability } from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

/**
 * Applies the cross-agent filesystem sandbox to an agent process's shell
 * commands at spawn. The whole shell — and anything it forks — runs under a
 * kernel policy that denies reading or writing other agents' memory while
 * leaving the current agent's own directory, the repo, and temp writable.
 *
 * Shared by every shell executor — the `Bash` tool (`bash.ts`), the Codex
 * `exec_command`/`write_stdin` sessions (`exec-command.ts`), and the Gemini
 * `run_shell_command` path (`shell.ts`) — so the kernel owns the whole shell
 * surface, not just one dialect.
 *
 * This is the SOLE cross-agent enforcement for spawned shells: the static
 * cross-agent guard no longer analyzes shell commands (it was bypassable by
 * symlinks, command substitution, globbing, and subprocesses). The kernel
 * resolves real paths regardless of how the command spelled them.
 *
 * Enabled by default; set `LETTA_FS_SANDBOX=0` to opt out. No-ops when the host
 * has no sandbox backend.
 */

export interface ShellSandboxResult {
  launcher: string[];
  env: NodeJS.ProcessEnv;
  /** The backend the launcher was wrapped with, or null when left unchanged. */
  backend: SandboxBackend | null;
}

/**
 * Apply the cross-agent sandbox to an agent shell launcher. Returns the
 * launcher (possibly wrapped) and the env to spawn it with (carrying the
 * sandbox sentinel when wrapped). Returns the inputs unchanged when the shared
 * gate ({@link resolveShellSandboxContext}) says this process's shells are not
 * to be wrapped (flag off, already sandboxed, no backend, cwd inside the agents
 * tree, or no resolvable self roots).
 */
export function applyShellSandbox(
  launcher: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** Injectable for tests; defaults to a real host probe. */
  availability?: SandboxAvailability,
): ShellSandboxResult {
  const unchanged: ShellSandboxResult = { launcher, env, backend: null };

  // The gate short-circuits on the flag before any host probe, so the
  // sandbox-off hot path stays a no-op. When it returns a context it has already
  // resolved the backend, both agents trees, and the agent's memory roots — so
  // we wall off both backend forests (a cloud/API agent must not traverse
  // local-backend memfs, and vice versa) without re-probing or re-resolving.
  const ctx = resolveShellSandboxContext(cwd, env, availability);
  if (!ctx) return unchanged;

  const selfRoots = deriveSelfAgentRootsForTrees(
    ctx.memoryRoots,
    ctx.agentsTreeRoots,
  );
  const policy = buildCrossAgentSandboxPolicy({
    selfRoots,
    agentsTreeRoots: ctx.agentsTreeRoots,
  });
  const wrapped = wrapLauncher(launcher, policy, {
    backend: ctx.backend,
    bwrapPath: ctx.bwrapPath,
  });
  if (!wrapped || wrapped.length === 0) return unchanged;

  return {
    launcher: wrapped,
    env: { ...env, [SANDBOX_ENV_VAR]: ctx.backend },
    backend: ctx.backend,
  };
}
