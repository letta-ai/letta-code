import { describe, expect, test } from "bun:test";
import { spawnWithLauncher } from "@/tools/impl/shell-runner";

function stubbornProcessTreeLauncher(): string[] {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    "setTimeout(() => process.exit(0), 7000);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const launcherScript = [
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", process.argv[1]], { stdio: "inherit" });',
    'process.stdout.write("descendant:" + descendant.pid + "\\n");',
    'process.on("SIGTERM", () => {});',
    "setTimeout(() => process.exit(0), 7000);",
    "setInterval(() => {}, 1000);",
  ].join("");
  return [process.execPath, "-e", launcherScript, descendantScript];
}

function expectProcessExited(pid: number): void {
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("spawnWithLauncher", () => {
  test("force-kills a timed-out process tree that ignores graceful termination", async () => {
    let output = "";
    const startedAt = Date.now();

    let error: unknown;
    try {
      await spawnWithLauncher(stubbornProcessTreeLauncher(), {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 500,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Command timed out");
    expect(Date.now() - startedAt).toBeLessThan(4000);

    const descendantPid = Number(output.match(/descendant:(\d+)/)?.[1]);
    expectProcessExited(descendantPid);
  }, 10_000);

  test("force-kills an aborted process tree that ignores graceful termination", async () => {
    const controller = new AbortController();
    let output = "";
    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(), 500);

    let error: unknown;
    try {
      await spawnWithLauncher(stubbornProcessTreeLauncher(), {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
        signal: controller.signal,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      clearTimeout(abortTimer);
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(Date.now() - startedAt).toBeLessThan(4000);

    const descendantPid = Number(output.match(/descendant:(\d+)/)?.[1]);
    expectProcessExited(descendantPid);
  }, 10_000);
});
