import picomatch from "picomatch";
import {
  ensureLettaIgnoreFile,
  readLettaIgnorePatterns,
} from "./ignoredDirectories";

interface CwdConfig {
  nameMatchers: picomatch.Matcher[];
  pathMatchers: picomatch.Matcher[];
}

/**
 * Cache of compiled matchers keyed by absolute cwd path.
 * Compiled once per unique cwd for performance, re-built when cwd changes.
 */
const cwdConfigCache = new Map<string, CwdConfig>();

function buildConfig(cwd: string): CwdConfig {
  const patterns = readLettaIgnorePatterns(cwd);
  const nameMatchers: picomatch.Matcher[] = [];
  const pathMatchers: picomatch.Matcher[] = [];

  for (const raw of patterns) {
    const normalized = raw.replace(/\/$/, ""); // strip trailing slash
    if (normalized.includes("/")) {
      // Path-based patterns: match against the full relative path
      pathMatchers.push(picomatch(normalized, { dot: true }));
    } else {
      // Name-based patterns: match against the entry basename, case-insensitively
      // so that e.g. "node_modules" also matches "Node_Modules" on case-sensitive FSes.
      nameMatchers.push(picomatch(normalized, { dot: true, nocase: true }));
    }
  }

  return { nameMatchers, pathMatchers };
}

/**
 * Returns the compiled matchers for the given root directory.
 * Builds and caches on first access per root; returns cached result thereafter.
 *
 * @param root - Workspace directory to load ignore patterns from (reads `<root>/.letta/.lettaignore`).
 *               Defaults to `process.cwd()`.
 */
function getConfig(root?: string): CwdConfig {
  const dir = root ?? process.cwd();
  const cached = cwdConfigCache.get(dir);
  if (cached) return cached;

  const config = buildConfig(dir);
  cwdConfigCache.set(dir, config);
  return config;
}

// On module load: ensure .lettaignore exists for the initial cwd and prime the cache.
(() => {
  const cwd = process.cwd();
  ensureLettaIgnoreFile(cwd);
  cwdConfigCache.set(cwd, buildConfig(cwd));
})();

/**
 * Invalidate the cached config for a given directory so it is re-read on the
 * next call to shouldExcludeEntry / shouldHardExcludeEntry. Call this after
 * writing or deleting .letta/.lettaignore in that directory.
 */
export function invalidateFileSearchConfig(cwd: string = process.cwd()): void {
  cwdConfigCache.delete(cwd);
}

/**
 * Returns true if the given entry should be excluded from the file index.
 * Applies patterns from .letta/.lettaignore for the current working directory.
 *
 * Use this when building the index. For disk scan fallback paths, use
 * shouldHardExcludeEntry() which matches against entry names only.
 *
 * @param name         - The entry's basename (e.g. "node_modules", ".env")
 * @param relativePath - Optional path relative to root (e.g. "src/generated/foo.ts").
 *                       Required for path-based .lettaignore patterns to work.
 * @param root         - Project root directory (reads `<root>/.letta/.lettaignore`).
 *                       Defaults to `process.cwd()`.
 */
export function shouldExcludeEntry(
  name: string,
  relativePath?: string,
  root?: string,
): boolean {
  const { nameMatchers, pathMatchers } = getConfig(root);

  // Name-based .lettaignore patterns (e.g. *.log, vendor)
  if (nameMatchers.length > 0 && nameMatchers.some((m) => m(name))) return true;

  // Path-based .lettaignore patterns (e.g. src/generated/**)
  if (
    relativePath &&
    pathMatchers.length > 0 &&
    pathMatchers.some((m) => m(relativePath))
  )
    return true;

  return false;
}

/**
 * Returns true if the given entry should be excluded from disk scan fallbacks.
 * Applies name-based .lettaignore patterns only (no path patterns, since only
 * the entry name is available during a shallow disk scan).
 *
 * @param name - The entry's basename (e.g. "node_modules", "dist")
 * @param root - Project root directory (reads `<root>/.letta/.lettaignore`).
 *               Defaults to `process.cwd()`.
 */
export function shouldHardExcludeEntry(name: string, root?: string): boolean {
  const { nameMatchers } = getConfig(root);
  return nameMatchers.length > 0 && nameMatchers.some((m) => m(name));
}
