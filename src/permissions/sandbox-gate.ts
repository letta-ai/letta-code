import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
  warnSandboxBackendUnavailable,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { resolveAllowedMemoryRoots } from "./memory-paths";
import {
  canonicalizeRoot,
  getCrossBackendAgentsTreeRoots,
} from "./sandbox-policy";

/**
 * Everything `applyShellSandbox` needs to wrap a launcher, resolved once. The
 * gate computes the backend, the agents trees, and the agent's memory roots
 * while deciding whether to wrap at all; returning them lets the wrapper build
 * the policy without re-probing the host or re-resolving the same paths.
 */
export interface ShellSandboxContext {
  /** The validated backend to wrap with (never null). */
  backend: SandboxBackend;
  /** Resolved bwrap binary path, when `backend === "bwrap"`. */
  bwrapPath?: string;
  /** Resolved Windows helper path, when `backend === "windows"`. */
  windowsHelperPath?: string;
  /** Both backend agents trees to wall off (canonical). */
  agentsTreeRoots: string[];
  /** The agent's resolvable memory roots, to carve self back out of the trees. */
  memoryRoots: string[];
}

/**
 * Resolve the context for confining an agent process's shell commands under the
 * kernel cross-agent sandbox, or null when this process's shells must not be
 * wrapped (flag off, already sandboxed, no backend, cwd inside the agents tree,
 * or no resolvable self roots).
 *
 * The kernel sandbox is the sole cross-agent enforcement for spawned shells (the
 * static cross-agent guard no longer analyzes shell commands), so this is what
 * `applyShellSandbox` consults to decide whether — and with what — to wrap.
 */
export function resolveShellSandboxContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): ShellSandboxContext | null {
  if (!isFsSandboxEnabled(env)) return null;
  // Already inside a sandbox: memory-mode subagents are confined as whole
  // processes at spawn, so their nested shell commands must not be double
  // wrapped. Non-memory subagents do not have this sentinel and should get the
  // same per-shell-command sandbox as parent agents.
  if (env[SANDBOX_ENV_VAR]) return null;

  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) {
    warnSandboxBackendUnavailable(avail, "agent shell sandbox");
    return null;
  }

  const cwdRoot = canonicalizeRoot(cwd);
  const agentsTreeRoots = getCrossBackendAgentsTreeRoots({ env });
  // Avoid launching from a protected tree root itself on every backend: there is
  // no self/parent carveout for the tree root, so this should not become an
  // unconfined shell just because the cwd is awkward.
  for (const agentsTreeRoot of agentsTreeRoots) {
    if (cwdRoot === agentsTreeRoot) {
      return null;
    }
  }

  // A read-deny on a cwd ancestor empties the child env under Seatbelt; bwrap has
  // similar cwd-inside-masked-tree hazards. The wrapper bails on macOS/Linux
  // when cwd is inside the tree, so the guard must not defer then. The Windows
  // helper can safely try to launch from protected cwd values: self cwd is carved
  // back, while other-agent cwd fails closed.
  if (avail.backend !== "windows") {
    for (const agentsTreeRoot of agentsTreeRoots) {
      if (cwdRoot.startsWith(`${agentsTreeRoot}/`)) {
        return null;
      }
    }
  }

  // No resolvable self roots → nothing safe to carve out → the wrapper bails.
  const memoryRoots = resolveAllowedMemoryRoots({ env }).roots;
  if (memoryRoots.length === 0) return null;

  return {
    backend: avail.backend,
    bwrapPath: avail.bwrapPath,
    windowsHelperPath: avail.windowsHelperPath,
    agentsTreeRoots,
    memoryRoots,
  };
}

/**
 * Whether an agent process's shell commands will be confined by the kernel
 * cross-agent sandbox — i.e. exactly the conditions under which
 * `applyShellSandbox` wraps the launcher. Thin boolean view over
 * {@link resolveShellSandboxContext}.
 */
export function willSandboxShell(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): boolean {
  return resolveShellSandboxContext(cwd, env, availability) !== null;
}
