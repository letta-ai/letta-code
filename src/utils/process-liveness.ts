import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

/** Signal 0 checks existence without delivering anything; EPERM means alive but not ours. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Start time of a process as the OS reports it, or null when it cannot be
 * read. Rendered in UTC with the C locale so every process on the machine
 * produces the same string for the same pid regardless of its own TZ.
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await promisify(execFile)("powershell", [
            "-NoProfile",
            "-Command",
            `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
          ])
        : await promisify(execFile)(
            "ps",
            ["-o", "lstart=", "-p", String(pid)],
            { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
          );
    const started = stdout.trim();
    return started.length > 0 ? started : null;
  } catch {
    return null;
  }
}

let ownStartTime: Promise<string | null> | undefined;

/** This process's own start time, resolved once; it cannot change. */
export function getOwnProcessStartTime(): Promise<string | null> {
  ownStartTime ??= getProcessStartTime(process.pid);
  return ownStartTime;
}

export interface ProcessIdentity {
  pid: number;
  /** Start time from getProcessStartTime, so a reused pid is not mistaken for the original. */
  started?: string;
}

/**
 * Is the recorded process still the one running under that pid? Liveness
 * alone is not enough because pids are recycled; a recorded start time settles
 * it. Without one, or when the OS cannot report it, liveness decides.
 */
export async function isSameProcessRunning(
  identity: ProcessIdentity,
): Promise<boolean> {
  if (!isProcessAlive(identity.pid)) return false;
  if (!identity.started) return true;
  const started = await getProcessStartTime(identity.pid);
  return started === null || started === identity.started;
}

/** The pid's command line via `ps`, or null on Windows or when ps fails. */
export function getProcessCommand(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * True only when a live pid is positively identified as non-letta, i.e. its
 * command neither mentions letta nor runs this process's entry script or
 * runtime (dev/bun-run instances). Our own pid, Windows, and a failed `ps`
 * lookup all report false so the owner stays held.
 */
export function isPidReusedByNonLetta(
  pid: number,
  getCommand: (pid: number) => string | null = getProcessCommand,
): boolean {
  const command = pid === process.pid ? null : getCommand(pid);
  if (!command || /letta/i.test(command)) return false;
  const script = process.argv[1];
  if (script && command.includes(script)) return false;
  const argv0 = command.split(/\s+/)[0] ?? "";
  return basename(argv0) !== basename(process.execPath);
}
