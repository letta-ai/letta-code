import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  buildMemorySubagentSandboxPolicy,
  getCrossBackendAgentsTreeRoots,
} from "@/permissions/sandbox-policy";
import type { SandboxAvailability } from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";

export interface MemoryConfinementLauncherInput {
  /** Command and arguments for the process that should be confined. */
  launcher: string[];
  /**
   * Environment for the confined process. `MEMORY_DIR` (or
   * `LETTA_MEMORY_DIR`) identifies the memory root that stays writable.
   */
  env: NodeJS.ProcessEnv;
}

export interface MemoryConfinementLauncherResult {
  /** Sandbox wrapper followed by the original launcher. */
  launcher: string[];
  /** Original environment plus the nested-sandbox sentinel. */
  env: NodeJS.ProcessEnv;
  backend: SandboxBackend;
}

function normalizeRoot(path: string): string {
  const trimmed = path.trim();
  const expanded = trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed.startsWith("$HOME/")
      ? join(homedir(), trimmed.slice(6))
      : trimmed;
  return resolve(expanded);
}

function resolveWritableMemoryRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const value of [env.MEMORY_DIR, env.LETTA_MEMORY_DIR]) {
    if (!value?.trim()) continue;
    const root = normalizeRoot(value);
    roots.add(root);
    if (basename(root) === "memory") {
      roots.add(join(dirname(root), "memory-worktrees"));
    }
  }
  return [...roots];
}

function customHarnessWritableRoots(env: NodeJS.ProcessEnv): string[] {
  return [env.LETTA_LOCAL_BACKEND_DIR, env.LETTA_TRANSCRIPT_ROOT]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeRoot);
}

export function createMemoryConfinementLauncherWithAvailability(
  input: MemoryConfinementLauncherInput,
  availability: SandboxAvailability,
): MemoryConfinementLauncherResult {
  if (input.launcher.length === 0) {
    throw new Error("Memory confinement requires a non-empty launcher.");
  }

  const memoryRoots = resolveWritableMemoryRoots(input.env);
  if (memoryRoots.length === 0) {
    throw new Error(
      "Memory confinement requires MEMORY_DIR or LETTA_MEMORY_DIR.",
    );
  }
  if (!availability.backend) {
    throw new Error(
      `Memory confinement is unavailable: ${availability.reason}.`,
    );
  }

  const localBackendStorageDir =
    input.env.LETTA_LOCAL_BACKEND_DIR?.trim() || undefined;
  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots,
    agentsTreeRoots: getCrossBackendAgentsTreeRoots({
      env: input.env,
      localBackendStorageDir,
    }),
    harnessWritableRoots: customHarnessWritableRoots(input.env),
  });
  const launcher = wrapLauncher(input.launcher, policy, {
    backend: availability.backend,
    bwrapPath: availability.bwrapPath,
  });
  if (!launcher) {
    throw new Error("Memory confinement could not wrap the launcher.");
  }

  return {
    launcher,
    env: { ...input.env, [SANDBOX_ENV_VAR]: availability.backend },
    backend: availability.backend,
  };
}
