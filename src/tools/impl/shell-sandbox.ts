import {
  getLocalBackendCrossAgentTreeRoot,
  isLocalBackendEnvEnabled,
} from "@/backend/local/paths";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import { willSandboxParentShell } from "@/permissions/sandbox-gate";
import {
  buildCrossAgentSandboxPolicy,
  canonicalizeRoot,
  deriveSelfAgentRoots,
  getDefaultAgentsTreeRoot,
} from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

/**
 * Applies the cross-agent filesystem sandbox to the *parent* agent's shell
 * commands at spawn. The whole shell — and anything it forks — runs under a
 * kernel policy that denies reading or writing other agents' memory while
 * leaving the agent's own directory, the repo, and temp writable.
 *
 * Shared by every parent shell executor — the `Bash` tool (`bash.ts`), the
 * Codex `exec_command`/`write_stdin` sessions (`exec-command.ts`), and the
 * Gemini `run_shell_command` path (`shell.ts`) — so the kernel owns the whole
 * shell surface, not just one dialect.
 *
 * This is the kernel-enforced backstop for the static cross-agent guard: it
 * closes the bypasses static command analysis can't (symlinks, command
 * substitution, globbing, subprocesses) because the kernel resolves real paths
 * regardless of how the command spelled them.
 *
 * Gated behind `LETTA_FS_SANDBOX=1` while the per-host bring-up is validated.
 */

export interface ParentShellSandboxResult {
  launcher: string[];
  env: NodeJS.ProcessEnv;
  /** The backend the launcher was wrapped with, or null when left unchanged. */
  backend: SandboxBackend | null;
}

/**
 * Apply the cross-agent sandbox to a parent-agent shell launcher. Returns the
 * launcher (possibly wrapped) and the env to spawn it with (carrying the
 * sandbox sentinel when wrapped). Returns the inputs unchanged when the shared
 * gate ({@link willSandboxParentShell}) says this process's shells are not to be
 * wrapped (flag off, already sandboxed, a subagent, no backend, cwd inside the
 * agents tree, or no resolvable self roots).
 */
export function applyParentShellSandbox(
  launcher: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** Injectable for tests; defaults to a real host probe. */
  availability?: SandboxAvailability,
): ParentShellSandboxResult {
  const unchanged: ParentShellSandboxResult = { launcher, env, backend: null };

  // The gate short-circuits on the flag before any host probe, so the
  // sandbox-off hot path stays a no-op.
  if (!willSandboxParentShell(cwd, env, availability)) return unchanged;
  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) return unchanged;

  // The local backend keeps memory under `lc-local-backend/memfs`, not
  // `~/.letta/agents`; wall off that tree instead so cross-agent isolation
  // actually applies. Resolved after the gate so the sandbox-off hot path does
  // no filesystem work. The parent agent's cwd is the repo (outside both trees),
  // so the gate's default-tree empty-env check stays correct either way.
  const agentsTreeRoot = isLocalBackendEnvEnabled(env)
    ? canonicalizeRoot(getLocalBackendCrossAgentTreeRoot())
    : getDefaultAgentsTreeRoot();
  const memoryRoots = resolveAllowedMemoryRoots({ env }).roots;
  const selfRoots = deriveSelfAgentRoots(memoryRoots, agentsTreeRoot);

  const policy = buildCrossAgentSandboxPolicy({ selfRoots, agentsTreeRoot });
  const wrapped = wrapLauncher(launcher, policy, {
    backend: avail.backend,
    bwrapPath: avail.bwrapPath,
  });
  if (!wrapped || wrapped.length === 0) return unchanged;

  return {
    launcher: wrapped,
    env: { ...env, [SANDBOX_ENV_VAR]: avail.backend },
    backend: avail.backend,
  };
}
