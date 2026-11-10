import type { Readable, Writable } from "node:stream";
import { spawnManagedWorkloadProcess } from "@/agent/subagents/subagent-process";
export interface CodexAppServerTransport {
  stdout: Readable;
  stderr?: Readable;
  stdin: Writable;
  kill?: () => void;
  exited?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnCodexTransport(options: {
  configArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): CodexAppServerTransport {
  const controller = new AbortController();
  const running = spawnManagedWorkloadProcess(
    "codex",
    [...(options.configArgs ?? []), "app-server", "--stdio"],
    {
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
    },
  );
  const child = running.process;
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => controller.abort(),
    exited: running.completion.then((exit) => ({
      code: exit.exitCode,
      signal: exit.exitSignal,
    })),
  };
}
