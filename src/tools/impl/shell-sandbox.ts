import { resolveShellSandboxContext } from "@/permissions/sandbox-gate";
import {
  buildCrossAgentSandboxPolicy,
  deriveSelfAgentRootsForTrees,
} from "@/permissions/sandbox-policy";
import {
  buildWorkspaceSandboxPolicy,
  resolveWorkspaceSandbox,
} from "@/permissions/workspace-sandbox";
import { getRuntimeContext } from "@/runtime-context";
import {
  detectSandboxBackend,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

export interface ShellSandboxResult {
  launcher: string[];
  env: NodeJS.ProcessEnv;
  backend: SandboxBackend | null;
}

export function applyShellSandbox(
  launcher: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  availability?: SandboxAvailability,
): ShellSandboxResult {
  const unchanged: ShellSandboxResult = { launcher, env, backend: null };

  const requestedWorkspaceSandbox = getRuntimeContext()?.workspaceSandbox;
  if (requestedWorkspaceSandbox) {
    const available = availability ?? detectSandboxBackend();
    const backend = available.backend;
    if (!backend) {
      throw new Error(
        `workspace sandbox requires a kernel sandbox backend (${available.reason})`,
      );
    }
    const workspaceSandbox = resolveWorkspaceSandbox(
      requestedWorkspaceSandbox,
      { availability: available },
    );
    const wrapped = wrapLauncher(
      launcher,
      buildWorkspaceSandboxPolicy(workspaceSandbox),
      {
        backend,
        bwrapPath: available.bwrapPath,
      },
    );
    if (!wrapped || wrapped.length === 0) {
      throw new Error("workspace sandbox failed to wrap shell command");
    }
    return {
      launcher: wrapped,
      env: { ...env, [SANDBOX_ENV_VAR]: backend },
      backend,
    };
  }

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
