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
 * This is the single source of truth shared by the wrapper (which acts on it)
 * and the cross-agent guard (which uses it to safely defer its bypassable
 * static shell analysis to the kernel). Keeping one predicate means the guard's
 * belief about what is confined can never drift from what actually gets wrapped.
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
