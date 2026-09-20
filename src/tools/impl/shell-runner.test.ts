import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  __testSetBackend,
  type Backend,
  type ConversationUpdateBody,
} from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  GITHUB_PR_ATTRIBUTION_TIMEOUT_MS,
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

  test("waits for PR attribution before completing the shell", async () => {
    let releaseUpdate!: () => void;
    const updateAllowed = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let resolveUpdateStarted!: (tags: string[]) => void;
    const updateStarted = new Promise<string[]>((resolve) => {
      resolveUpdateStarted = resolve;
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
        resolveUpdateStarted(Array.isArray(tags) ? tags : []);
        await updateAllowed;
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

    await expect(updateStarted).resolves.toEqual([
      "channel:slack",
      "github:pull-request:letta-ai:letta-code:3744",
    ]);
    const completionState = running.completion.then(() => "completed");
    expect(
      await Promise.race([
        completionState,
        Bun.sleep(20).then(() => "pending"),
      ]),
    ).toBe("pending");

    releaseUpdate();
    await expect(completionState).resolves.toBe("completed");
  });

  test("starts the attribution deadline only after a long-running shell exits", async () => {
    let persisted = false;
    __testSetBackend({
      retrieveConversation: async () => ({ id: "conv-shell", tags: [] }),
      updateConversation: async () => {
        persisted = true;
        return { id: "conv-shell" };
      },
    } as unknown as Backend);

    const running = runWithRuntimeContext(
      { agentId: "agent-shell", conversationId: "conv-shell" },
      () =>
        startShellProcess(
          [
            process.execPath,
            "-e",
            `setTimeout(() => process.stdout.write("https://github.com/letta-ai/letta-code/pull/3746\\n"), ${GITHUB_PR_ATTRIBUTION_TIMEOUT_MS + 100})`,
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            timeoutMs: GITHUB_PR_ATTRIBUTION_TIMEOUT_MS + 1_000,
            sourceCommand: "gh pr create --fill",
          },
        ),
    );

    await expect(running.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(persisted).toBe(true);
  });

  test("bounds stalled PR attribution after shell completion", async () => {
    __testSetBackend({
      retrieveConversation: async () => ({ id: "conv-shell", tags: [] }),
      updateConversation: async (
        _id: string,
        _body: ConversationUpdateBody,
        options?: { signal?: AbortSignal },
      ) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    } as unknown as Backend);

    const startedAt = Date.now();
    const running = runWithRuntimeContext(
      { agentId: "agent-shell", conversationId: "conv-shell" },
      () =>
        startShellProcess(
          [
            process.execPath,
            "-e",
            'process.stdout.write("https://github.com/letta-ai/letta-code/pull/3745\\n")',
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            timeoutMs: 1000,
            sourceCommand: "gh pr create --fill",
          },
        ),
    );

    await expect(running.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
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
