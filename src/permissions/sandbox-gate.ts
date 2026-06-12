import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
  warnSandboxBackendUnavailable,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import {
  getLocalBackendCrossAgentTreeRoot,
  getLocalBackendStorageDir,
} from "@/utils/local-backend-paths";
import { resolveAllowedMemoryRoots } from "./memory-paths";
import { canonicalizeRoot, getDefaultAgentsTreeRoot } from "./sandbox-policy";

function isLocalBackendEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.LETTA_LOCAL_BACKEND_EXPERIMENTAL?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Whether an agent process's shell commands will be confined by the kernel
 * cross-agent sandbox — i.e. exactly the conditions under which
 * `applyShellSandbox` wraps the launcher.
 *
 * The kernel sandbox is the sole cross-agent enforcement for spawned shells (the
 * static cross-agent guard no longer analyzes shell commands), so this predicate
 * is what the wrapper consults to decide whether to wrap.
 */
export function willSandboxShell(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): boolean {
  if (!isFsSandboxEnabled(env)) return false;
  // Already inside a sandbox: memory-mode subagents are confined as whole
  // processes at spawn, so their nested shell commands must not be double
  // wrapped. Non-memory subagents do not have this sentinel and should get the
  // same per-shell-command sandbox as parent agents.
  if (env[SANDBOX_ENV_VAR]) return false;

  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) {
    warnSandboxBackendUnavailable(avail, "agent shell sandbox");
    return false;
  }

  const cwdRoot = canonicalizeRoot(cwd);
  const agentsTreeRoots = [getDefaultAgentsTreeRoot()];
  if (isLocalBackendEnvEnabled(env)) {
    agentsTreeRoots.push(
      canonicalizeRoot(
        getLocalBackendCrossAgentTreeRoot(
          getLocalBackendStorageDir(undefined, env),
        ),
      ),
    );
  }
  // A read-deny on a cwd ancestor empties the child env under Seatbelt; the
  // wrapper bails when cwd is inside the tree, so the guard must not defer then.
  for (const agentsTreeRoot of agentsTreeRoots) {
    if (
      cwdRoot === agentsTreeRoot ||
      cwdRoot.startsWith(`${agentsTreeRoot}/`)
    ) {
      return false;
    }
  }

  // No resolvable self roots → nothing safe to carve out → the wrapper bails.
  return resolveAllowedMemoryRoots({ env }).roots.length > 0;
}
