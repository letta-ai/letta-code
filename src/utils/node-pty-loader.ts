/**
 * Guarded loader for node-pty.
 *
 * node-pty's install script (`scripts/prebuild.js`) only checks that
 * `prebuilds/<platform>-<arch>/` *exists* — it never validates that the binary
 * inside is usable, and its presence suppresses the `node-gyp rebuild` fallback.
 * The linux-x64 prebuild is linked against glibc, which produces two distinct
 * failures on systems the prebuild was not built for:
 *
 * - glibc older than the prebuild's floor (GLIBC_2.28): `require` throws a raw
 *   dynamic-link error. Catchable, but useless to the user as-is.
 * - musl (Alpine): `require` *succeeds*, and the first `spawn()` call
 *   **segfaults the process**. Verified on node:22-alpine with
 *   node-pty@1.2.0-beta.14. Nothing in JS can catch that, so the only safe
 *   option is to refuse to load a glibc prebuild on a musl runtime.
 *
 * Both cases surface as a tagged error that callers detect with
 * `isNodePtyUnavailableError` and handle by degrading (a pipe instead of a PTY)
 * rather than crashing.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const NODE_PTY_UNAVAILABLE_CODE = "LETTA_NODE_PTY_UNAVAILABLE";

const REBUILD_HINT =
  "Reinstall with `npm_config_build_from_source=true` to compile node-pty from " +
  "source (requires make, python3 and a C++ toolchain).";

function tagUnavailable(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  (error as { code?: string }).code = NODE_PTY_UNAVAILABLE_CODE;
  return error;
}

export function formatNodePtyUnavailableMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Failed to load node-pty: ${detail}\n${REBUILD_HINT}`;
}

/**
 * Runs `load` and normalizes any failure into a tagged error. Exported
 * separately from `requireNodePty` so the failure path is testable without
 * module mocking.
 */
export function loadNodePtyWith(load: () => unknown): unknown {
  try {
    return load();
  } catch (cause) {
    throw tagUnavailable(formatNodePtyUnavailableMessage(cause), cause);
  }
}

/**
 * Returns a reason string when node-pty must not be loaded at all, or null when
 * loading is safe. Takes its probes as arguments so both branches are testable.
 */
export function findUnusableNodePtyReason(probes: {
  platform: string;
  isMuslRuntime: () => boolean;
  hasSourceBuild: () => boolean;
}): string | null {
  if (probes.platform !== "linux") return null;
  if (!probes.isMuslRuntime()) return null;
  // A locally compiled binding is linked against musl and is safe to use; only
  // the shipped glibc prebuild is dangerous here.
  if (probes.hasSourceBuild()) return null;
  return (
    "node-pty's prebuilt binary is linked against glibc, but this system uses musl " +
    "(Alpine). Calling into it segfaults the process, so the PTY is disabled.\n" +
    REBUILD_HINT
  );
}

/**
 * musl builds of Node report no glibc version in their diagnostic report; glibc
 * builds report e.g. "2.36". Same signal `detect-libc` uses.
 */
function isMuslRuntime(): boolean {
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (!report?.header) return false;
    return report.header.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

function hasSourceBuild(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageJsonPath = require.resolve("node-pty/package.json");
    return existsSync(
      join(dirname(packageJsonPath), "build", "Release", "pty.node"),
    );
  } catch {
    return false;
  }
}

let cachedUnusableReason: string | null | undefined;

export function requireNodePty(): unknown {
  if (cachedUnusableReason === undefined) {
    cachedUnusableReason = findUnusableNodePtyReason({
      platform: process.platform,
      isMuslRuntime,
      hasSourceBuild,
    });
  }
  if (cachedUnusableReason) {
    throw tagUnavailable(cachedUnusableReason);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return loadNodePtyWith(() => require("node-pty"));
}

export function isNodePtyUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === NODE_PTY_UNAVAILABLE_CODE
  );
}
