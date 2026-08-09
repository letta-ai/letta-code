import { describe, expect, test } from "bun:test";
import {
  spawnWithLauncher,
  startShellProcess,
} from "@/tools/impl/shell-runner";

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

describe("shared shell process", () => {
  test("returns the process handle separately from completion", async () => {
    const running = startShellProcess(
      [process.execPath, "-e", 'process.stdout.write("shared")'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
      },
    );

    expect(typeof running.process.kill).toBe("function");
    expect(await running.completion).toEqual({
      stdout: "shared",
      stderr: "",
      exitCode: 0,
    });
  });

  test.skipIf(process.platform === "win32")(
    "supports writable PTY processes",
    async () => {
      const running = startShellProcess(
        ["bash", "-c", 'read value; printf "read:%s" "$value"'],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 2000,
          tty: true,
        },
      );

      running.process.write("hello\n");
      const result = await running.completion;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("read:hello");
    },
  );

  test("can stream output without retaining a second copy", async () => {
    let streamed = "";
    const running = startShellProcess(
      [process.execPath, "-e", 'process.stdout.write("streamed")'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
        captureOutput: false,
        onOutput: (chunk) => {
          streamed += chunk;
        },
      },
    );

    expect(await running.completion).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(streamed).toBe("streamed");
  });

  test("decodes buffered output after joining split UTF-8 bytes", async () => {
    const result = await spawnWithLauncher(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 25)",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
      },
    );

    expect(result.stdout).toBe("😀");
  });

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
