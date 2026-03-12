import picomatch from "picomatch";
import {
  ensureLettaIgnoreFile,
  readLettaIgnorePatterns,
} from "./ignoredDirectories";

/**
 * Hardcoded defaults — always excluded from both the file index and disk scans.
 * These cover the most common build/dependency directories across ecosystems.
 * Matched case-insensitively against the entry name.
 */
const DEFAULT_EXCLUDED = new Set([
  // JavaScript / Node
  "node_modules",
  "bower_components",
  // Build outputs
  "dist",
  "build",
  "out",
  "coverage",
  // Frameworks
  ".next",
  ".nuxt",
  // Python
  "venv",
  ".venv",
  "__pycache__",
  ".tox",
  // Rust / Maven / Java
  "target",
  // Version control & tooling
  ".git",
  ".cache",
]);

/**
 * Pre-compiled matchers from .lettaignore, split by whether the pattern
 * is name-based (no slash → match against entry name) or path-based
 * (contains slash → match against the full relative path).
 * Compiled once at module load for performance.
 */
const { nameMatchers, pathMatchers } = (() => {
  // Create .lettaignore with defaults if the project doesn't have one yet.
  // Must run before readLettaIgnorePatterns() so the file exists when we read it.
  ensureLettaIgnoreFile();
  const patterns = readLettaIgnorePatterns();
  const nameMatchers: picomatch.Matcher[] = [];
  const pathMatchers: picomatch.Matcher[] = [];

  for (const raw of patterns) {
    const normalized = raw.replace(/\/$/, ""); // strip trailing slash
    if (normalized.includes("/")) {
      pathMatchers.push(picomatch(normalized, { dot: true }));
    } else {
      nameMatchers.push(picomatch(normalized, { dot: true }));
    }
  }

  return { nameMatchers, pathMatchers };
})();

/**
 * Returns true if the given entry should be excluded from the file index.
 * Applies both the hardcoded defaults and any .lettaignore patterns.
 *
 * Use this when building the index — .lettaignore controls what gets cached,
 * not what the user can ever find. For disk scan fallback paths, use
 * shouldHardExcludeEntry() so .lettaignore-matched files remain discoverable.
 *
 * @param name         - The entry's basename (e.g. "node_modules", ".env")
 * @param relativePath - Optional path relative to cwd (e.g. "src/generated/foo.ts").
 *                       Required for path-based .lettaignore patterns to work.
 */
export function shouldExcludeEntry(
  name: string,
  relativePath?: string,
): boolean {
  // Fast path: hardcoded defaults (O(1) Set lookup)
  if (DEFAULT_EXCLUDED.has(name.toLowerCase())) return true;

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
 * Only applies the hardcoded defaults — .lettaignore patterns are intentionally
 * skipped here so users can still find those files with an explicit @ search.
 *
 * @param name - The entry's basename (e.g. "node_modules", "dist")
 */
export function shouldHardExcludeEntry(name: string): boolean {
  return DEFAULT_EXCLUDED.has(name.toLowerCase());
}
