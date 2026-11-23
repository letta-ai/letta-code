import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const PROCESS_START_LOOKUP_TIMEOUT_MS = 5_000;

export async function getProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await promisify(execFile)(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
            ],
            { timeout: PROCESS_START_LOOKUP_TIMEOUT_MS, windowsHide: true },
          )
        : await promisify(execFile)(
            "ps",
            ["-o", "lstart=", "-p", String(pid)],
            {
              env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
              timeout: PROCESS_START_LOOKUP_TIMEOUT_MS,
            },
          );
    const started = stdout.trim();
    return started.length > 0 ? started : null;
  } catch {
    return null;
  }
}

let ownStartTime: Promise<string | null> | undefined;

export function getOwnProcessStartTime(): Promise<string | null> {
  if (!ownStartTime) {
    const lookup = getProcessStartTime(process.pid);
    ownStartTime = lookup;
    void lookup.then((started) => {
      if (started === null && ownStartTime === lookup) {
        ownStartTime = undefined;
      }
    });
  }
  return ownStartTime;
}

export function resetOwnProcessStartTimeForTests(): void {
  ownStartTime = undefined;
}

export interface ProcessIdentity {
  pid: number;
  started?: string;
}

export async function isSameProcessRunning(
  identity: ProcessIdentity,
): Promise<boolean> {
  if (!isProcessAlive(identity.pid)) return false;
  if (!identity.started) return true;
  const started = await getProcessStartTime(identity.pid);
  return started === null || started === identity.started;
}

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
