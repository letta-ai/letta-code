import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildMemorySubagentSandboxPolicy,
  getCrossBackendAgentsTreeRoots,
  getLettaHomeRoot,
} from "@/permissions/sandbox-policy";
import {
  detectSandboxBackend,
  isFsSandboxEnabled,
  type SandboxAvailability,
  warnSandboxBackendUnavailable,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR, type SandboxBackend } from "@/sandbox/policy";
import { wrapLauncher } from "@/sandbox/wrap";
import { getTranscriptRoot } from "@/utils/transcript-paths";
import type { SubagentLaunchProfile } from ".";

interface SubagentLauncher {
  command: string;
  args: string[];
}

export interface WrapSubagentLauncherInput {
  launcher: SubagentLauncher;
  launchProfile: SubagentLaunchProfile | undefined;
  backendMode: string;
  memoryRoots: string[];
  inheritedPrimaryRoot: string | null;
  memoryScope?: {
    primaryRoot: string | null;
    writableRoots: string[];
    readonlyRoots?: string[];
  };
  localBackendStorageDir?: string | null;
  scratchpadDir?: string | null;
  env?: NodeJS.ProcessEnv;
  availability?: SandboxAvailability;
}

export interface WrapSubagentLauncherResult {
  command: string;
  args: string[];
  sandboxEnv: Record<string, string>;
  backend: SandboxBackend;
}

export function wrapSubagentLauncher(
  input: WrapSubagentLauncherInput,
): WrapSubagentLauncherResult | null {
  const env = input.env ?? process.env;

  if (!isFsSandboxEnabled(env)) return null;
  if (input.launchProfile !== "memory-subagent") return null;

  const writableMemoryRoots = input.memoryScope
    ? [...input.memoryScope.writableRoots]
    : [...input.memoryRoots];
  const primaryRoot =
    input.memoryScope?.primaryRoot ?? input.inheritedPrimaryRoot;
  if (primaryRoot && !writableMemoryRoots.includes(primaryRoot)) {
    writableMemoryRoots.push(primaryRoot);
  }
  if (writableMemoryRoots.length === 0) return null;

  const availability = input.availability ?? detectSandboxBackend();
  if (!availability.backend) {
    warnSandboxBackendUnavailable(availability, "memory-subagent sandbox");
    return null;
  }

  const isLocal = input.backendMode === "local";
  const storageDir = input.localBackendStorageDir ?? undefined;
  const scratchpadDir = input.scratchpadDir || undefined;
  if (scratchpadDir) {
    mkdirSync(scratchpadDir, { recursive: true });
  }
  const harnessWritableRoots = [
    getTranscriptRoot(),
    ...(isLocal && storageDir ? [storageDir] : []),
    ...(scratchpadDir ? [scratchpadDir] : []),
  ];
  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: writableMemoryRoots,
    readonlyRoots: input.memoryScope?.readonlyRoots,
    agentsTreeRoots: getCrossBackendAgentsTreeRoots({
      env,
      localBackendStorageDir: storageDir,
    }),
    harnessWritableRoots,
  });

  const wrapped = wrapLauncher(
    [input.launcher.command, ...input.launcher.args],
    policy,
    { backend: availability.backend, bwrapPath: availability.bwrapPath },
  );
  if (!wrapped || wrapped.length === 0) return null;

  const [command, ...args] = wrapped;
  const scratchRoot = join(getLettaHomeRoot(), "tmp");
  mkdirSync(scratchRoot, { recursive: true });
  return {
    command: command as string,
    args,
    sandboxEnv: {
      [SANDBOX_ENV_VAR]: availability.backend,
      TMPDIR: scratchRoot,
      TMP: scratchRoot,
      TEMP: scratchRoot,
    },
    backend: availability.backend,
  };
}
