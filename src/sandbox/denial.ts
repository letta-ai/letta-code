/**
 * Heuristics for recognizing that a failure was caused by the sandbox rather
 * than by the command itself. There is no deterministic signal (Codex
 * acknowledges the same), so we match on errno for in-process tools and on
 * output keywords for shell commands.
 */

/** errno codes a blocked filesystem operation surfaces as. */
const SANDBOX_ERRNO = new Set(["EPERM", "EACCES", "EROFS"]);

const DENIAL_PATTERN =
  /operation not permitted|permission denied|read-only file system|not permitted|\bsandbox\b/i;

/**
 * True when an in-process file tool's error looks like a sandbox denial.
 * Accepts a Node errno string (`err.code`) or any error-ish value.
 */
export function isSandboxErrno(error: unknown): boolean {
  if (typeof error === "string") return SANDBOX_ERRNO.has(error);
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && SANDBOX_ERRNO.has(code);
  }
  return false;
}

/**
 * True when a shell command's nonzero exit + combined output looks like a
 * sandbox denial. Used to attach a clarifying hint to Bash tool results.
 */
export function isLikelySandboxDenial(
  exitCode: number | null,
  output: string,
): boolean {
  if (exitCode === 0 || exitCode === null) return false;
  return DENIAL_PATTERN.test(output);
}

/**
 * Build a user-facing hint explaining a sandbox denial, listing the roots the
 * agent may actually write to. Replaces the old five-category classifier.
 */
export function describeSandboxDenial(writableRoots: string[]): string {
  if (writableRoots.length === 0) {
    return "Blocked by the filesystem sandbox: this agent may not write outside its own memory.";
  }
  const roots = writableRoots.join(", ");
  return `Blocked by the filesystem sandbox: this agent may only write under ${roots}.`;
}
