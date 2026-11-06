const GIT_DEFAULT_TIMEOUT_MS = 60_000;
const GIT_TRANSFER_TIMEOUT_MS = 540_000;

const TRANSFER_COMMANDS = new Set(["clone", "fetch", "pull"]);

export function buildGitTransferStallArgs(args: string[]): string[] {
  if (!TRANSFER_COMMANDS.has(args[0] ?? "")) return [];
  return ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
}

export function getGitCommandTimeoutMs(
  args: string[],
  timeoutMs?: number,
): number {
  if (timeoutMs !== undefined) return timeoutMs;
  return TRANSFER_COMMANDS.has(args[0] ?? "")
    ? GIT_TRANSFER_TIMEOUT_MS
    : GIT_DEFAULT_TIMEOUT_MS;
}
