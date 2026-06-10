import { basename, dirname } from "node:path";

import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import {
  buildCrossAgentSandboxPolicy,
  canonicalizeRoot,
  getDefaultAgentsTreeRoot,
} from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
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

function isSubagentProcess(env: NodeJS.ProcessEnv): boolean {
  return env.LETTA_CODE_AGENT_ROLE === "subagent";
}

/** Whether a canonical path is the given root or nested inside it. */
function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Derive the self-agent directories to keep accessible inside the walled-off
 * agents tree. A memory root under the tree
 * (`~/.letta/agents/<id>/memory[-worktrees]`) carves out the whole agent dir
 * (`~/.letta/agents/<id>`) so self memory, worktrees, and any sibling state
 * stay readable/writable — matching the static guard's self allowance. Roots
 * outside the tree (a custom `MEMORY_DIR`) are kept as-is.
 */
function deriveSelfRoots(
  memoryRoots: string[],
  agentsTreeRoot: string,
): string[] {
  const out = new Set<string>();
  for (const root of memoryRoots) {
    const canon = canonicalizeRoot(root);
    if (canon !== agentsTreeRoot && isWithin(canon, agentsTreeRoot)) {
      const leaf = basename(canon);
      out.add(
        leaf === "memory" || leaf === "memory-worktrees"
          ? dirname(canon)
          : canon,
      );
    } else {
      out.add(canon);
    }
  }
  return [...out];
}

/**
 * Apply the cross-agent sandbox to a parent-agent shell launcher. Returns the
 * launcher (possibly wrapped) and the env to spawn it with (carrying the
 * sandbox sentinel when wrapped). Returns the inputs unchanged — a no-op — when
 * any of these hold:
 *   - the `LETTA_FS_SANDBOX` flag is off,
 *   - the process is already inside a sandbox (avoid nested `sandbox-exec`,
 *     which the kernel blocks),
 *   - the process is a subagent (parent-only here; subagents are confined as a
 *     whole process at spawn instead),
 *   - no sandbox backend exists on this host,
 *   - the cwd is inside the agents tree (a read-deny on a cwd ancestor empties
 *     the child env under Seatbelt), or
 *   - self memory roots can't be resolved (nothing safe to carve out, so
 *     denying the tree could trap the agent out of its own memory).
 */
export function applyParentShellSandbox(
  launcher: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** Injectable for tests; defaults to a real host probe. */
  availability?: SandboxAvailability,
): ParentShellSandboxResult {
  const unchanged: ParentShellSandboxResult = { launcher, env, backend: null };

  if (!isFsSandboxEnabled(env)) return unchanged;
  if (env[SANDBOX_ENV_VAR]) return unchanged;
  if (isSubagentProcess(env)) return unchanged;

  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) return unchanged;

  const agentsTreeRoot = getDefaultAgentsTreeRoot();

  // Seatbelt empties the child env when a cwd ancestor is read-denied. The
  // parent's cwd is normally the repo (outside the tree); bail if it isn't.
  if (isWithin(canonicalizeRoot(cwd), agentsTreeRoot)) return unchanged;

  const memoryRoots = resolveAllowedMemoryRoots({ env }).roots;
  const selfRoots = deriveSelfRoots(memoryRoots, agentsTreeRoot);
  if (selfRoots.length === 0) return unchanged;

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
