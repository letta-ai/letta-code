import { spawn } from "node:child_process";

const RUNTIME_SANDBOX_IMAGE =
  "node:22.18.0-bookworm@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputCapBytes: number;
  stdin?: string;
  label: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  signal?: NodeJS.Signals | null;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

/**
 * Runs untrusted package install scripts and the closed-source Claude binary in
 * a container that can see only its disposable probe root. The Docker client
 * receives only the already-minimized command environment; secret values are
 * inherited by name rather than placed in argv.
 */
export function sandboxClaudeCommand(
  spec: CommandSpec,
  root: string,
): CommandSpec {
  const containerRoot = "/watch";
  const mapPath = (value: string): string =>
    value === root || value.startsWith(`${root}/`)
      ? `${containerRoot}${value.slice(root.length)}`
      : value;
  const args = [
    "run",
    "--rm",
    "--network",
    "bridge",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--volume",
    `${root}:${containerRoot}:rw`,
    "--workdir",
    mapPath(spec.cwd),
  ];
  for (const [key, value] of Object.entries(spec.env)) {
    if (value === undefined || key === "PATH") continue;
    args.push(
      "--env",
      AUTH_ENV_KEYS.includes(key as (typeof AUTH_ENV_KEYS)[number])
        ? key
        : `${key}=${mapPath(value)}`,
    );
  }
  args.push(
    RUNTIME_SANDBOX_IMAGE,
    mapPath(spec.command),
    ...spec.args.map(mapPath),
  );
  return {
    ...spec,
    command: "/usr/bin/docker",
    args,
    cwd: root,
  };
}

/** Spawn with bounded output and terminate the whole process group on timeout/cap. */
export const runBoundedCommand: CommandRunner = (spec) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = {
      stdout: [],
      stderr: [],
    };
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, spec.timeoutMs);
    const collect = (which: "stdout" | "stderr", value: Buffer) => {
      const remaining = spec.outputCapBytes - bytes;
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        chunks[which].push(kept);
        bytes += kept.length;
      }
      if (value.length > remaining) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on("data", (value: Buffer) => collect("stdout", value));
    child.stderr.on("data", (value: Buffer) => collect("stderr", value));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(
          new Error(`Command ${spec.label} could not start: ${error.message}`),
        );
      }
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolvePromise({
          exitCode,
          signal,
          stdout: Buffer.concat(chunks.stdout).toString("utf8"),
          stderr: Buffer.concat(chunks.stderr).toString("utf8"),
          timedOut,
          truncated,
        });
      }
    });
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });
