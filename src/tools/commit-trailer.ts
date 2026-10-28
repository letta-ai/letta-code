/**
 * Commit trailer that the Bash and ExecCommand tool descriptions tell the agent
 * to append to git commit messages.
 *
 * The descriptions contain a `{{COMMIT_TRAILER}}` placeholder. By default it
 * becomes the standard Letta Code co-author line. Deployments that run the
 * agent under their own identity can set `BASH_COMMIT_TRAILER` to a single
 * trailer line (for example `Co-Authored-By: Example Bot <bot@example.com>`)
 * to use instead.
 */

export const COMMIT_TRAILER_PLACEHOLDER = "{{COMMIT_TRAILER}}";

export const DEFAULT_COMMIT_TRAILER =
  "Co-Authored-By: Letta Code <noreply@letta.com>";

const MAX_COMMIT_TRAILER_LENGTH = 200;

/**
 * Returns the trailer to use. Falls back to the default when the variable is
 * unset, blank, multi-line, or unreasonably long, so a bad value can never
 * inject extra instructions into the tool description.
 */
export function resolveCommitTrailer(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.BASH_COMMIT_TRAILER;
  if (raw === undefined) return DEFAULT_COMMIT_TRAILER;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_COMMIT_TRAILER_LENGTH ||
    /[\r\n]/.test(trimmed)
  ) {
    return DEFAULT_COMMIT_TRAILER;
  }
  return trimmed;
}

/** Replaces every trailer placeholder in a tool description. */
export function applyCommitTrailer(
  description: string,
  trailer: string = resolveCommitTrailer(),
): string {
  return description.split(COMMIT_TRAILER_PLACEHOLDER).join(trailer);
}
