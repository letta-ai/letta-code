import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { SandboxBackend } from "./policy.js";
import { SANDBOX_EXEC_PATH } from "./seatbelt.js";

export interface SandboxAvailability {
  backend: SandboxBackend | null;
  bwrapPath?: string;
  reason: string;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  force?: boolean;
}

let cached: SandboxAvailability | null = null;
const warnedUnavailableContexts = new Set<string>();

export function detectSandboxBackend(
  options: DetectOptions = {},
): SandboxAvailability {
  const platform = options.platform ?? process.platform;

  if (!options.force && cached && !options.platform) {
    return cached;
  }

  const result = probe(platform);

  if (!options.platform) {
    cached = result;
  }
  return result;
}

export function resetSandboxAvailabilityCache(): void {
  cached = null;
}

export function isFsSandboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.LETTA_FS_SANDBOX?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function isShellSandboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.LETTA_FS_SANDBOX?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function warnSandboxBackendUnavailable(
  availability: SandboxAvailability,
  context: string,
): void {
  if (availability.backend) return;
  const key = `${context}:${availability.reason}`;
  if (warnedUnavailableContexts.has(key)) return;
  warnedUnavailableContexts.add(key);
  console.warn(
    `[sandbox] WARNING: ${context} requested filesystem isolation, but no ` +
      `kernel sandbox backend is available (${availability.reason}). ` +
      `Continuing without filesystem sandbox isolation.`,
  );
}

function probe(platform: NodeJS.Platform): SandboxAvailability {
  if (platform === "darwin") {
    if (existsSync(SANDBOX_EXEC_PATH)) {
      return { backend: "seatbelt", reason: "sandbox-exec available" };
    }
    return {
      backend: null,
      reason: `${SANDBOX_EXEC_PATH} not found`,
    };
  }

  if (platform === "linux") {
    return probeBwrap();
  }

  return {
    backend: null,
    reason: `no filesystem sandbox backend for platform "${platform}"`,
  };
}

function probeBwrap(): SandboxAvailability {
  const bwrapPath = resolveExecutableOnPath("bwrap");
  if (!bwrapPath) {
    return { backend: null, reason: "bwrap not found on PATH" };
  }

  const version = spawnSync(bwrapPath, ["--version"], { timeout: 5000 });
  if (version.error || version.status !== 0) {
    return { backend: null, reason: "bwrap not found on PATH" };
  }

  const userns = spawnSync(
    bwrapPath,
    ["--ro-bind", "/", "/", "--unshare-user", "/bin/true"],
    { timeout: 5000 },
  );
  if (userns.error || userns.status !== 0) {
    return {
      backend: null,
      reason: "bwrap present but user namespaces are unavailable",
    };
  }

  return { backend: "bwrap", bwrapPath, reason: "bwrap available" };
}

function resolveExecutableOnPath(
  executable: string,
  envPath: string | undefined = process.env.PATH,
): string | null {
  if (isAbsolute(executable) && existsSync(executable)) return executable;
  for (const dir of (envPath ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
