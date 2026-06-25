import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Override the CPU architecture (for tests). Defaults to `process.arch`. */
  architecture?: string;
  /** Override env lookup (for tests / CI). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the standard system bwrap path (for tests). */
  systemBwrapPath?: string | null;
  /** Override the package root used for bundled resource lookup (for tests). */
  bundledRoot?: string | null;
  /** Override the expected bundled bwrap SHA-256 (for tests). */
  expectedBundledSha256?: string | null;
  /** Bypass the module-level cache (for tests / re-probing). */
  force?: boolean;
}

declare const __BUNDLED_BWRAP_SHA256__: Record<string, string> | undefined;

const BWRAP_OVERRIDE_ENV = "LETTA_BWRAP_PATH";
const SYSTEM_BWRAP_PATH = "/usr/bin/bwrap";
const BUNDLED_BWRAP_RESOURCE_DIR = join("vendor", "bwrap");
const BUNDLED_BWRAP_MANIFEST = "manifest.json";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

const BUNDLED_BWRAP_SHA256: Record<string, string | undefined> =
  typeof __BUNDLED_BWRAP_SHA256__ === "object" && __BUNDLED_BWRAP_SHA256__
    ? __BUNDLED_BWRAP_SHA256__
    : {};

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
  const cacheable =
    !options.force &&
    !options.platform &&
    !options.architecture &&
    !options.env &&
    options.systemBwrapPath === undefined &&
    options.bundledRoot === undefined &&
    options.expectedBundledSha256 === undefined;

  if (cacheable && cached) {
    return cached;
  }

  const result = probe(platform, options);

  if (cacheable) {
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

function probe(
  platform: NodeJS.Platform,
  options: DetectOptions,
): SandboxAvailability {
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
    return probeBwrap(options);
  }

  return {
    backend: null,
    reason: `no filesystem sandbox backend for platform "${platform}"`,
  };
}

function probeBwrap(options: DetectOptions): SandboxAvailability {
  const env = options.env ?? process.env;
  const override = env[BWRAP_OVERRIDE_ENV]?.trim();
  if (override) {
    const overridePath = resolveExecutable(override, env.PATH);
    if (!overridePath) {
      return {
        backend: null,
        reason: `${BWRAP_OVERRIDE_ENV}=${override} was not found`,
      };
    }
    return validateBwrapPath(overridePath, "LETTA_BWRAP_PATH override");
  }

  const systemBwrapPath = options.systemBwrapPath ?? SYSTEM_BWRAP_PATH;
  if (systemBwrapPath && existsSync(systemBwrapPath)) {
    return validateBwrapPath(systemBwrapPath, "system bwrap");
  }

  const pathBwrap = resolveExecutableOnPath("bwrap", env.PATH, systemBwrapPath);
  if (pathBwrap) {
    return validateBwrapPath(pathBwrap, "PATH bwrap");
  }

  const bundledBwrap = resolveBundledBwrapPath(options);
  if (bundledBwrap) {
    const verification = verifyBundledBwrapDigest(bundledBwrap, options);
    if (verification) {
      return { backend: null, reason: verification };
    }
    return validateBwrapPath(bundledBwrap, "bundled bwrap");
  }

  return {
    backend: null,
    reason: "bwrap not found on /usr/bin, PATH, or bundled resources",
  };
}

function validateBwrapPath(path: string, source: string): SandboxAvailability {
  const version = spawnSync(path, ["--version"], { timeout: 5000 });
  if (version.error || version.status !== 0) {
    return { backend: null, reason: `${source} failed --version` };
  }

  // Confirm unprivileged user namespaces actually work (they don't in WSL1 or
  // some hardened/container hosts). A read-only root + /bin/true is the
  // cheapest mount that exercises the namespace machinery. A bundled binary can
  // replace a missing executable, but it cannot fix host userns policy.
  const userns = spawnSync(
    path,
    ["--ro-bind", "/", "/", "--unshare-user", "/bin/true"],
    { timeout: 5000 },
  );
  if (userns.error || userns.status !== 0) {
    return {
      backend: null,
      reason: `${source} present but user namespaces are unavailable`,
    };
  }

  return { backend: "bwrap", bwrapPath: path, reason: `${source} available` };
}

function resolveExecutable(
  executable: string,
  envPath: string | undefined,
): string | null {
  if (isAbsolute(executable)) return existsSync(executable) ? executable : null;
  if (executable.includes("/")) {
    const candidate = resolve(executable);
    return existsSync(candidate) ? candidate : null;
  }
  return resolveExecutableOnPath(executable, envPath);
}

function resolveExecutableOnPath(
  executable: string,
  envPath: string | undefined = process.env.PATH,
  skipPath: string | null = null,
): string | null {
  for (const dir of (envPath ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, executable);
    if (candidate === skipPath) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBundledBwrapPath(options: DetectOptions): string | null {
  const packageRoot = options.bundledRoot ?? findPackageRoot();
  if (!packageRoot) return null;

  const key = bundledBwrapKey(options.architecture ?? arch());
  if (!key) return null;

  const candidate = join(packageRoot, BUNDLED_BWRAP_RESOURCE_DIR, key, "bwrap");
  return existsSync(candidate) ? candidate : null;
}

function bundledBwrapKey(architecture: string): string | null {
  switch (architecture) {
    case "arm64":
      return "linux-arm64";
    case "x64":
      return "linux-x64";
    default:
      return null;
  }
}

function findPackageRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        if (packageJson?.name === "@letta-ai/letta-code") return current;
      } catch {
        // Keep walking; this may be an unrelated package.json.
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readBundledBwrapManifestSha256(
  key: string,
  options: DetectOptions,
): string | null {
  const packageRoot = options.bundledRoot ?? findPackageRoot();
  if (!packageRoot) return null;

  const manifestPath = join(
    packageRoot,
    BUNDLED_BWRAP_RESOURCE_DIR,
    BUNDLED_BWRAP_MANIFEST,
  );
  if (!existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const sha256 = manifest?.targets?.[key]?.sha256;
    return typeof sha256 === "string" ? sha256 : null;
  } catch {
    return null;
  }
}

function verifyBundledBwrapDigest(
  path: string,
  options: DetectOptions,
): string | null {
  const key = bundledBwrapKey(options.architecture ?? arch());
  const expected =
    options.expectedBundledSha256 ??
    (key &&
      (BUNDLED_BWRAP_SHA256[key] ??
        readBundledBwrapManifestSha256(key, options)));
  if (!expected) {
    return "bundled bwrap SHA-256 is not configured";
  }
  if (!SHA256_HEX_RE.test(expected)) {
    return "bundled bwrap SHA-256 is invalid";
  }

  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected.toLowerCase()) {
    return `bundled bwrap SHA-256 mismatch: expected ${expected.toLowerCase()}, got ${actual}`;
  }
  return null;
}
