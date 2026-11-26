import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import {
  __resetCodexSessionsForTests,
  sendCodexMessage,
  startCodexTurn,
  stopCodexSession,
} from "./codex-app-server";
import { FakeCodexTransport } from "./codex-test-transport";

afterEach(() => __resetCodexSessionsForTests());

describe("Codex app-server settlement", () => {
  test("fails active completion and evicts the session when stdout closes", async () => {
    const first = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => first.transport() },
    );
    first.stderr.write("boom");
    first.stdout.end();
    expect(await handle.completion).toMatchObject({
      success: false,
      error: expect.stringContaining("boom"),
    });
    const second = new FakeCodexTransport();
    await sendCodexMessage(
      {
        threadId: "thread-1",
        prompt: "retry",
        parentAgentId: "parent",
        cwd: "/repo",
      },
      {
        env: { HOME: "/home/test", PATH: "/usr/bin:/bin" },
        createTransport: ({ env }) => {
          if (process.platform !== "win32") {
            expect(env.PATH).toBe("/usr/bin:/bin:/home/test/.local/bin");
          }
          return second.transport();
        },
      },
    );
    expect(second.requests.map((request) => request.method)).toContain(
      "thread/resume",
    );
  });

  test.each([
    {
      code: null,
      signal: "SIGKILL" as const,
      detail: "",
      expected: " (signal SIGKILL; possibly out of memory)",
    },
    {
      code: null,
      signal: "SIGTERM" as const,
      detail: "",
      expected: " (signal SIGTERM; possibly out of memory)",
    },
    { code: 137, signal: null, detail: "", expected: " (exit code 137)" },
    { code: 0, signal: null, detail: "", expected: " (exit code 0)" },
    {
      code: null,
      signal: "SIGKILL" as const,
      detail: "boom",
      expected: " (signal SIGKILL; possibly out of memory): boom",
    },
    {
      code: 143,
      signal: null,
      detail: "startup warning",
      expected: " (exit code 143; possibly out of memory): startup warning",
    },
    {
      code: null,
      signal: "SIGTERM" as const,
      detail: `stale startup warning${"tail".repeat(100)}`,
      expected: ` (signal SIGTERM; possibly out of memory): ${"tail".repeat(75)}`,
    },
  ])(
    "reports transport exit info with stderr tail: $expected",
    async ({ code, signal, detail, expected }) => {
      const fake = new FakeCodexTransport();
      let resolveExit!: (exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void;
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        resolveExit = resolve;
      });
      const handle = await startCodexTurn(
        { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
        {
          createTransport: () => ({
            ...fake.transport(),
            childExit: exited,
            exited: new Promise(() => {}),
          }),
        },
      );
      fake.stderr.write(detail);
      resolveExit({ code, signal });
      expect(await handle.completion).toMatchObject({
        success: false,
        error: `Codex app-server closed${expected}`,
      });
    },
  );

  test.each(["childExit", "exited"] as const)(
    "preserves the exit signal when stdout ends before %s",
    async (exitSource) => {
      const fake = new FakeCodexTransport();
      const exit = Promise.withResolvers<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>();
      const handle = await startCodexTurn(
        { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
        {
          createTransport: () => ({
            ...fake.transport(),
            childExit: new Promise(() => {}),
            exited: new Promise(() => {}),
            [exitSource]: exit.promise,
          }),
        },
      );
      const eof = once(fake.stdout, "end");
      fake.stdout.end();
      await eof;
      exit.resolve({ code: null, signal: "SIGKILL" });
      expect(await handle.completion).toMatchObject({
        success: false,
        error:
          "Codex app-server closed (signal SIGKILL; possibly out of memory)",
      });
    },
  );

  test("settles and kills the child when stdout ends without an exit", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      {
        createTransport: () => ({
          ...fake.transport(),
          childExit: new Promise(() => {}),
          exited: new Promise(() => {}),
        }),
      },
    );
    fake.stdout.end();
    expect(await handle.completion).toMatchObject({
      success: false,
      error: "Codex app-server closed",
    });
    expect(fake.killed).toBe(true);
  }, 1_000);

  test("rejects pending requests when stdout errors and the child does not exit", async () => {
    const stdout = new PassThrough();
    const startedAt = Date.now();
    const pending = startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      {
        createTransport: () => ({
          stdin: new PassThrough(),
          stdout,
          exited: new Promise(() => {}),
        }),
      },
    );
    const rejected = pending.catch((error: unknown) => error);
    stdout.destroy(new Error("stdout failed"));
    expect(await rejected).toEqual(new Error("Codex app-server closed"));
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("fails the active turn when stdout errors and the child does not exit", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      {
        createTransport: () => ({
          ...fake.transport(),
          exited: new Promise(() => {}),
        }),
      },
    );
    const startedAt = Date.now();
    fake.stdout.destroy(new Error("stdout failed"));
    expect(await handle.completion).toMatchObject({
      success: false,
      error: "Codex app-server closed",
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test.each([false, true])(
    "settles on stdout EOF with terminal frame: %s",
    async (terminal) => {
      const fake = new FakeCodexTransport();
      const handle = await startCodexTurn(
        { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
        {
          createTransport: () => ({
            ...fake.transport(),
            exited: new Promise(() => {}),
          }),
        },
      );
      if (terminal) fake.complete("finished");
      fake.stdout.end();
      expect(await handle.completion).toMatchObject(
        terminal ? { success: true, report: "finished" } : { success: false },
      );
    },
  );

  test("fails immediately on a non-retrying error for the active turn", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    fake.errorNotification({ message: "different turn" }, "turn-other");
    fake.errorNotification({ message: "Reconnecting... 1/5" }, "turn-1", true);
    fake.errorNotification({
      message: "stream disconnected before completion",
    });
    expect(await handle.completion).toMatchObject({
      success: false,
      error: "stream disconnected before completion",
    });
  });
});

test("stopping Codex waits for the CLI process exit rather than a turn interrupt", async () => {
  const fake = new FakeCodexTransport();
  let finish!: (exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    finish = resolve;
  });
  const turn = await startCodexTurn(
    { parentAgentId: "parent", cwd: "/repo", prompt: "work" },
    {
      createTransport: () => ({ ...fake.transport(), exited }),
    },
  );
  let acknowledged = false;
  const stopping = stopCodexSession(turn.threadId).then((result) => {
    acknowledged = true;
    return result;
  });
  await Bun.sleep(0);
  expect(fake.killed).toBe(true);
  expect(acknowledged).toBe(false);
  finish({ code: null, signal: "SIGTERM" });
  expect(await stopping).toBe(true);
  await turn.completion;
});
