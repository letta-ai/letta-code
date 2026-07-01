import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { SandboxBackend } from "./policy.js";
import { SANDBOX_EXEC_PATH } from "./seatbelt.js";

export interface SandboxAvailability {
  /** The usable backend, or null when none is available on this host. */
  backend: SandboxBackend | null;
  /** Resolved bwrap binary path, when `backend === "bwrap"`. */
  bwrapPath?: string;
  /** Human-readable explanation, primarily for the null case. */
  reason: string;
}

export interface DetectOptions {
  /** Override the platform (for tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Bypass the module-level cache (for tests / re-probing). */
  force?: boolean;
}

let cached: SandboxAvailability | null = null;
const warnedUnavailableContexts = new Set<string>();

/**
 * Detect which filesystem-sandbox backend works on this host, probing for real
 * (Seatbelt: binary presence; bwrap: an actual user-namespace mount probe).
 * Result is cached for the process since it cannot change mid-run.
 */
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

/** Clear the cached probe result (tests only). */
export function resetSandboxAvailabilityCache(): void {
  cached = null;
}

/**
 * Whether filesystem sandboxing is enabled. It is **on by default** now that the
 * kernel backends (Seatbelt + bwrap) are validated; set `LETTA_FS_SANDBOX=0`
 * (or `false`) to opt out. When no backend is available on the host,
 * {@link detectSandboxBackend} returns `{backend:null}` and every sandbox entry
 * point no-ops regardless of this flag.
 *
 * Lives in this leaf so both subagent spawning (agent layer) and parent Bash
 * wrapping (tools layer) gate on the same check without importing each other.
 */
export function isFsSandboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.LETTA_FS_SANDBOX?.trim().toLowerCase();
  // Default on: only an explicit off-switch disables it.
  return value !== "0" && value !== "false";
}

/**
 * Emit a loud, once-per-process warning when sandboxing was requested but this
 * host cannot provide a kernel backend. We intentionally continue rather than
 * fail closed: users can still work, but should know filesystem isolation is
 * degraded on this host.
 */
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
  // `bwrap` must exist on PATH (a bundled fallback can be wired in later).
  const bwrapPath = resolveExecutableOnPath("bwrap");
  if (!bwrapPath) {
    return { backend: null, reason: "bwrap not found on PATH" };
  }

  const version = spawnSync(bwrapPath, ["--version"], { timeout: 5000 });
  if (version.error || version.status !== 0) {
    return { backend: null, reason: "bwrap not found on PATH" };
  }

  // Confirm unprivileged user namespaces actually work (they don't in WSL1 or
  // some hardened/container hosts). A read-only root + /bin/true is the
  // cheapest mount that exercises the namespace machinery.
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
