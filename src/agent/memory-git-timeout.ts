const GIT_DEFAULT_TIMEOUT_MS = 60_000;
// Pushes can upload as much as a clone downloads (e.g. a backlog of large commits).
const GIT_PUSH_TIMEOUT_MS = 180_000;

export function defaultMs(op: string | undefined): number {
  return op === "push" ? GIT_PUSH_TIMEOUT_MS : GIT_DEFAULT_TIMEOUT_MS;
}

/**
 * execFile kills git with SIGTERM on timeout and the error carries no git
 * output, so callers only saw "Command failed: git ...". Name the timeout.
 */
export function describe(
  error: unknown,
  op: string | undefined,
  timeoutMs: number,
): unknown {
  if (!(error instanceof Error)) return error;
  const e = error as Error & { killed?: boolean; signal?: string | null };
  if (!e.killed || e.signal !== "SIGTERM") return error;
  e.message = `git ${op ?? "command"} timed out after ${Math.round(timeoutMs / 1000)}s\n${e.message}`;
  return e;
}
