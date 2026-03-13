import picomatch from "picomatch";
import {
  ensureLettaIgnoreFile,
  readLettaIgnorePatterns,
} from "./ignoredDirectories";

/**
 * Pre-compiled matchers from .lettaignore, split by whether the pattern
 * is name-based (no slash → match against entry name) or path-based
 * (contains slash → match against the full relative path).
 * Compiled once at module load for performance.
 */
const { nameMatchers, pathMatchers } = (() => {
  // Create .lettaignore with a commented-out template if the project doesn't
  // have one yet. Must run before readLettaIgnorePatterns() so the file exists
  // when we read it.
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
 * Applies patterns from .lettaignore only — there are no hardcoded defaults.
 *
 * Use this when building the index. For disk scan fallback paths, use
 * shouldHardExcludeEntry() which matches against entry names only.
 *
 * @param name         - The entry's basename (e.g. "node_modules", ".env")
 * @param relativePath - Optional path relative to cwd (e.g. "src/generated/foo.ts").
 *                       Required for path-based .lettaignore patterns to work.
 */
export function shouldExcludeEntry(
  name: string,
  relativePath?: string,
): boolean {
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
 */
export function shouldHardExcludeEntry(name: string): boolean {
  return nameMatchers.length > 0 && nameMatchers.some((m) => m(name));
}
