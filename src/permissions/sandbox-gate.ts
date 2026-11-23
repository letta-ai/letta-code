import {
  detectSandboxBackend,
  isShellSandboxEnabled,
  type SandboxAvailability,
  warnSandboxBackendUnavailable,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { resolveAllowedMemoryRoots } from "./memory-paths";
import {
  canonicalizeRoot,
  getCrossBackendAgentsTreeRoots,
} from "./sandbox-policy";

export interface ShellSandboxContext {
  backend: SandboxBackend;
  bwrapPath?: string;
  agentsTreeRoots: string[];
  memoryRoots: string[];
}

export function resolveShellSandboxContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): ShellSandboxContext | null {
  if (!isShellSandboxEnabled(env)) return null;
  if (env[SANDBOX_ENV_VAR]) return null;

  const avail = availability ?? detectSandboxBackend();
  if (!avail.backend) {
    warnSandboxBackendUnavailable(avail, "agent shell sandbox");
    return null;
  }

  const cwdRoot = canonicalizeRoot(cwd);
  const agentsTreeRoots = getCrossBackendAgentsTreeRoots({ env });
  for (const agentsTreeRoot of agentsTreeRoots) {
    if (
      cwdRoot === agentsTreeRoot ||
      cwdRoot.startsWith(`${agentsTreeRoot}/`)
    ) {
      return null;
    }
  }

  const memoryRoots = resolveAllowedMemoryRoots({ env }).roots;
  if (memoryRoots.length === 0) return null;

  return {
    backend: avail.backend,
    bwrapPath: avail.bwrapPath,
    agentsTreeRoots,
    memoryRoots,
  };
}

export function willSandboxShell(
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): boolean {
  return resolveShellSandboxContext(cwd, env, availability) !== null;
}
