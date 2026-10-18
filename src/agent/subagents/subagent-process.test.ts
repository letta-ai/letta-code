import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnManagedWorkloadProcess,
  spawnSubagentProcess,
} from "@/agent/subagents/subagent-process";
import { WORKLOAD_SYSTEMD_SLICE_ENV } from "@/utils/systemd-workload-scope";

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} remained alive`);
}

describe.skipIf(process.platform === "win32")("subagent process", () => {
  test("stops the launcher and a descendant that outlives graceful cancellation", async () => {
    const descendantScript = [
      'process.on("SIGINT", () => {});',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("");
    const launcherScript = [
      'const { spawn } = require("node:child_process");',
      'const descendant = spawn(process.execPath, ["-e", process.argv[1]], { stdio: ["ignore", "pipe", "ignore"] });',
      'descendant.stdout.once("data", () => process.stdout.write(String(descendant.pid) + "\\n"));',
      'process.on("SIGINT", () => process.exit(130));',
      "setInterval(() => {}, 1000);",
    ].join("");
    const controller = new AbortController();
    const running = spawnSubagentProcess(
      process.execPath,
      ["-e", launcherScript, descendantScript],
      {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        forceKillGraceMs: 100,
      },
    );

    const [chunk] = await once(running.process.stdout, "data");
    const descendantPid = Number(String(chunk).trim());
    expect(descendantPid).toBeGreaterThan(0);

    controller.abort();
    const result = await running.completion;

    expect(running.wasAborted()).toBe(true);
    expect(result.exitCode).toBe(130);
    await waitForProcessExit(descendantPid);
  }, 10_000);
});

describe.skipIf(process.platform !== "linux")(
  "managed workload process",
  () => {
    // Stand-in for systemd-run: records its options, then execs the command
    // after `--` in place, as `systemd-run --scope` does.
    function installFakeSystemdRun(): { binDir: string; argsFile: string } {
      const binDir = mkdtempSync(join(tmpdir(), "fake-systemd-run-"));
      const argsFile = join(binDir, "args");
      const script = join(binDir, "systemd-run");
      writeFileSync(
        script,
        [
          "#!/bin/sh",
          `: > "${argsFile}"`,
          'while [ "$1" != "--" ]; do echo "$1" >> "' +
            argsFile +
            '"; shift; done',
          "shift",
          'exec "$@"',
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      return { binDir, argsFile };
    }

    // Reports its own PID, then echoes one stream-json line from stdin.
    const echoScript = [
      'process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n");',
      'process.stdin.once("data", (d) => { process.stdout.write(d); process.exit(0); });',
    ].join("");

    async function runEcho(env: NodeJS.ProcessEnv) {
      const running = spawnManagedWorkloadProcess(
        process.execPath,
        ["-e", echoScript],
        { cwd: process.cwd(), env },
      );
      let stdout = "";
      running.process.stdout.setEncoding("utf8");
      running.process.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      running.process.stdin.end('{"type":"user"}\n');
      const result = await running.completion;
      const [pidLine, echoLine] = stdout.trim().split("\n");
      return {
        result,
        launcherPid: running.process.pid,
        childPid: JSON.parse(pidLine ?? "{}").pid,
        echoLine,
      };
    }

    test("runs the CLI in the configured slice with stdio and PID intact", async () => {
      const { binDir, argsFile } = installFakeSystemdRun();
      const run = await runEcho({
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        [WORKLOAD_SYSTEMD_SLICE_ENV]: "letta-workload.slice",
      });

      expect(run.result.exitCode).toBe(0);
      expect(run.echoLine).toBe('{"type":"user"}');
      expect(run.childPid).toBe(run.launcherPid);
      const scopeArgs = readFileSync(argsFile, "utf8").trim().split("\n");
      expect(scopeArgs).toContain("--scope");
      expect(scopeArgs).toContain("--slice=letta-workload.slice");
    }, 10_000);

    test("spawns the CLI directly when no slice is configured", async () => {
      const { binDir, argsFile } = installFakeSystemdRun();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      delete env[WORKLOAD_SYSTEMD_SLICE_ENV];
      const run = await runEcho(env);

      expect(run.result.exitCode).toBe(0);
      expect(run.echoLine).toBe('{"type":"user"}');
      expect(existsSync(argsFile)).toBe(false);
    }, 10_000);
  },
);
