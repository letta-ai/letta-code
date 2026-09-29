import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testSetBackend,
  type Backend,
  type ConversationUpdateBody,
} from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  backgroundProcesses,
  releaseTransientBackgroundProcesses,
} from "@/tools/impl/process_manager";
import {
  __testCreateNativePtyProcessHandle,
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

function isProcessStillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endCommand = stat.lastIndexOf(")");
      const state =
        endCommand === -1 ? "" : stat.slice(endCommand + 2, endCommand + 3);
      // kill(pid, 0) succeeds for a zombie until it is reaped, but the
      // process has exited and can no longer keep inherited stdio open.
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }

  if (process.platform === "darwin") {
    try {
      const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      return state !== "" && !state.startsWith("Z");
    } catch {
      return false;
    }
  }

  return true;
}

function expectProcessExited(pid: number): void {
  expect(pid).toBeGreaterThan(0);
  expect(isProcessStillRunning(pid)).toBe(false);
}

describe("shared shell process", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

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
    expect(typeof running.terminate).toBe("function");
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

  test.skipIf(process.platform === "win32")(
    "native node-pty exposes a separate process-group kill for transient cleanup",
    () => {
      const ptyKill = mock((_signal?: string) => {});
      const processKill = spyOn(process, "kill").mockImplementation(
        ((_pid: number, _signal?: string | number) =>
          true) as typeof process.kill,
      );
      const handle = __testCreateNativePtyProcessHandle({
        pid: 4321,
        kill: ptyKill,
        write: () => {},
        onData: () => {},
        onExit: () => {},
      });

      const processId = "native-pty-transient-test";
      try {
        // Ordinary termination retains node-pty's direct-child behavior.
        handle.kill("SIGTERM");
        expect(ptyKill).toHaveBeenCalledWith("SIGTERM");
        expect(processKill).not.toHaveBeenCalled();

        backgroundProcesses.set(processId, {
          process: handle,
          command: "browser-control",
          status: "running",
          exitCode: null,
          transientExecutionContextId: "ctx-native-pty",
        });
        releaseTransientBackgroundProcesses("ctx-native-pty");

        expect(processKill).toHaveBeenCalledWith(-4321, "SIGKILL");
        expect(ptyKill).toHaveBeenCalledTimes(1);
      } finally {
        backgroundProcesses.delete(processId);
        processKill.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32" || !process.versions.bun)(
    "transient cleanup kills the Bun PTY group after its shell parent exits",
    async () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "native-pty-transient-"));
      const actionFile = join(fixtureDir, "action.txt");
      const childScript = join(fixtureDir, "delayed-child.cjs");
      writeFileSync(
        childScript,
        `const fs = require("node:fs"); process.on("SIGHUP", () => {}); setTimeout(() => fs.writeFileSync(${JSON.stringify(actionFile)}, "leaked"), 600); setInterval(() => {}, 1000);`,
      );
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} >/dev/null 2>&1 &`;
      const running = startShellProcess(["bash", "-c", command], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 2_000,
        tty: true,
      });
      const processId = "native-pty-completed-parent-test";

      try {
        expect((await running.completion).exitCode).toBe(0);
        backgroundProcesses.set(processId, {
          process: running.process,
          command,
          status: "completed",
          exitCode: 0,
          transientExecutionContextId: "ctx-native-pty-completed",
        });

        releaseTransientBackgroundProcesses("ctx-native-pty-completed");
        await Bun.sleep(750);

        expect(existsSync(actionFile)).toBe(false);
      } finally {
        try {
          running.process.killProcessGroup?.("SIGKILL");
        } catch {
          // Process group may already be gone.
        }
        backgroundProcesses.delete(processId);
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    5_000,
  );

  test.skipIf(process.platform === "win32" || !process.versions.bun)(
    "transient cleanup beats delayed Bun PTY pid delivery",
    async () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "bun-pty-pid-race-"));
      const actionFile = join(fixtureDir, "action.txt");
      const readyFile = join(fixtureDir, "ready.txt");
      const childScript = join(fixtureDir, "delayed-child.cjs");
      writeFileSync(
        childScript,
        `const fs = require("node:fs"); process.on("SIGHUP", () => {}); fs.writeFileSync(${JSON.stringify(readyFile)}, "ready"); setTimeout(() => fs.writeFileSync(${JSON.stringify(actionFile)}, "leaked"), 600); setInterval(() => {}, 1000);`,
      );
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} >/dev/null 2>&1 & wait`;
      const running = startShellProcess(["bash", "-c", command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LETTA_TEST_PTY_PID_REPORT_DELAY_MS: "1000",
        },
        timeoutMs: 2_000,
        tty: true,
      });
      const processId = "bun-pty-delayed-pid-test";

      try {
        backgroundProcesses.set(processId, {
          process: running.process,
          command,
          status: "running",
          exitCode: null,
          transientExecutionContextId: "ctx-bun-pty-delayed-pid",
        });
        const readyDeadline = Date.now() + 750;
        while (!existsSync(readyFile) && Date.now() < readyDeadline) {
          await Bun.sleep(10);
        }
        expect(existsSync(readyFile)).toBe(true);

        releaseTransientBackgroundProcesses("ctx-bun-pty-delayed-pid");
        await running.completion;
        await Bun.sleep(750);

        expect(existsSync(actionFile)).toBe(false);
      } finally {
        try {
          running.process.killProcessGroup?.("SIGKILL");
        } catch {
          // Process group may already be gone.
        }
        backgroundProcesses.delete(processId);
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    5_000,
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

  test("tracks PR output from the shared completion path", async () => {
    let resolveUpdate!: (tags: string[]) => void;
    const updateObserved = new Promise<string[]>((resolve) => {
      resolveUpdate = resolve;
    });
    __testSetBackend({
      retrieveConversation: async () => ({
        id: "conv-shell",
        tags: ["channel:slack"],
      }),
      updateConversation: async (
        _conversationId: string,
        body: ConversationUpdateBody,
      ) => {
        const tags = Reflect.get(body, "tags");
        resolveUpdate(Array.isArray(tags) ? tags : []);
        return { id: "conv-shell", tags };
      },
    } as unknown as Backend);

    const running = runWithRuntimeContext(
      { agentId: "agent-shell", conversationId: "conv-shell" },
      () =>
        startShellProcess(
          [
            process.execPath,
            "-e",
            'process.stdout.write("https://github.com/letta-ai/letta-code/pull/3744\\n")',
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            timeoutMs: 1000,
            captureOutput: false,
            sourceCommand: "gh pr create --fill",
          },
        ),
    );

    await running.completion;
    await expect(updateObserved).resolves.toEqual([
      "channel:slack",
      "github:pull-request:letta-ai:letta-code:3744",
    ]);
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

  test("decodes split UTF-8 bytes before streaming output", async () => {
    let streamed = "";
    const running = startShellProcess(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 25)",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
        captureOutput: false,
        onOutput: (chunk) => {
          streamed += chunk;
        },
      },
    );

    await running.completion;
    expect(streamed).toBe("😀");
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
