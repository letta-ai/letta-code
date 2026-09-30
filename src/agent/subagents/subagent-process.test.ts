import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { spawnSubagentProcess } from "@/agent/subagents/subagent-process";

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
  test("waits beyond the default kill window for remote listener cancellation", async () => {
    const script = [
      'process.on("SIGINT", () => {',
      '  setTimeout(() => { process.stdout.write("listener-cancelled\\n"); process.exit(1); }, 2200);',
      "});",
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("");
    const controller = new AbortController();
    const running = spawnSubagentProcess(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
      forceKillGraceMs: 3_000,
    });
    await once(running.process.stdout, "data");
    const output = once(running.process.stdout, "data");
    controller.abort();
    expect(String((await output)[0])).toContain("listener-cancelled");
    expect(await running.completion).toMatchObject({
      exitCode: 1,
      exitSignal: null,
    });
  }, 6_000);

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
