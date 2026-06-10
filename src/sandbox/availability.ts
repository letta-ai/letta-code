import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  const version = spawnSync("bwrap", ["--version"], { timeout: 5000 });
  if (version.error || version.status !== 0) {
    return { backend: null, reason: "bwrap not found on PATH" };
  }

  // Confirm unprivileged user namespaces actually work (they don't in WSL1 or
  // some hardened/container hosts). A read-only root + /bin/true is the
  // cheapest mount that exercises the namespace machinery.
  const userns = spawnSync(
    "bwrap",
    ["--ro-bind", "/", "/", "--unshare-user", "/bin/true"],
    { timeout: 5000 },
  );
  if (userns.error || userns.status !== 0) {
    return {
      backend: null,
      reason: "bwrap present but user namespaces are unavailable",
    };
  }

  return { backend: "bwrap", bwrapPath: "bwrap", reason: "bwrap available" };
}
