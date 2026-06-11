import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { resolveAllowedMemoryRoots } from "./memory-paths";
import { canonicalizeRoot, getDefaultAgentsTreeRoot } from "./sandbox-policy";

/**
 * Whether the parent agent's shell commands will be confined by the kernel
 * cross-agent sandbox — i.e. exactly the conditions under which
 * `applyParentShellSandbox` wraps the launcher.
 *
 * The kernel sandbox is the sole cross-agent enforcement for spawned shells (the
 * static cross-agent guard no longer analyzes shell commands), so this predicate
 * is what the wrapper consults to decide whether to wrap.
 */
export function willSandboxParentShell(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): boolean {
  if (!isFsSandboxEnabled(env)) return false;
  // Already inside a sandbox, or a subagent (confined as a whole process at
  // spawn): the parent-shell wrapper does not apply.
  if (env[SANDBOX_ENV_VAR]) return false;
  if (env.LETTA_CODE_AGENT_ROLE === "subagent") return false;

  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) return false;

  const agentsTreeRoot = getDefaultAgentsTreeRoot();
  // A read-deny on a cwd ancestor empties the child env under Seatbelt; the
  // wrapper bails when cwd is inside the tree, so the guard must not defer then.
  if (
    canonicalizeRoot(cwd) === agentsTreeRoot ||
    canonicalizeRoot(cwd).startsWith(`${agentsTreeRoot}/`)
  ) {
    return false;
  }

  // No resolvable self roots → nothing safe to carve out → the wrapper bails.
  return resolveAllowedMemoryRoots({ env }).roots.length > 0;
}
