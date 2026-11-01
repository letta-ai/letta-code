import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetClaudeSessionsForTests,
  buildClaudeStreamArgs,
  type ClaudeSessionTransport,
  hasActiveClaudeTurn,
  runClaudeTurn,
  sendClaudeMessage,
} from "./claude-stream-session";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function transportFixture(options: { exitOnStdinEnd?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let finish!: (value: {
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }) => void;
  const completion = new Promise<{
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }>((resolve) => {
    finish = resolve;
  });
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString()));
  let ended = false;
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    ended = true;
    return originalEnd(...args);
  }) as typeof stdin.end;
  if (options.exitOnStdinEnd !== false)
    stdin.on("finish", () => finish({ exitCode: 0, exitSignal: null }));
  const transport: ClaudeSessionTransport = {
    process: { stdin, stdout, stderr } as ClaudeSessionTransport["process"],
    completion,
    wasAborted: () => false,
  };
  const emit = (value: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify(value)}\n`);
  /** Echoes a written user input the way `--replay-user-messages` does. */
  const echo = (index: number) => {
    const input = JSON.parse(writes[index] ?? "") as Record<string, unknown>;
    emit({ ...input, isReplay: true, session_id: SESSION_ID });
  };
  return {
    transport,
    writes,
    stdout,
    stderr,
    finish,
    stdin,
    emit,
    echo,
    ended: () => ended,
  };
}

function parseWrite(
  fixture: ReturnType<typeof transportFixture>,
  index: number,
) {
  return JSON.parse(fixture.writes[index] ?? "") as Record<string, unknown>;
}

const base = { parentAgentId: "parent", cwd: "/repo" };

/** Background-wait tests must fail fast instead of hanging the shard. */
const BACKGROUND_TEST_TIMEOUT_MS = 5_000;

/**
 * Keep a ref'd handle alive while awaiting, so the test never depends on
 * whether the runtime keeps the loop alive for the session's own timers.
 */
async function awaitWithLiveLoop<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 5);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

/** End the fake process so no stream or timer leaks into the next test. */
function teardownFixture(fixture: ReturnType<typeof transportFixture>): void {
  if (!fixture.stdin.writableEnded) fixture.stdin.end();
  fixture.stdout.end();
  fixture.stderr.end();
  fixture.finish({ exitCode: 0, exitSignal: null });
}

afterEach(() => __resetClaudeSessionsForTests());

describe("Claude stream sessions", () => {
  test("launches unattended subagents with bypassed permissions", async () => {
    const args = buildClaudeStreamArgs({ sessionId: SESSION_ID });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
    expect(args).not.toContain("--allowed-tools");
    expect(args).toContain("--replay-user-messages");

    const fixture = transportFixture();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      {
        env: {},
        createTransport: (options) => {
          spawnedEnv = options.env;
          return fixture.transport;
        },
      },
    );
    await Bun.sleep(0);
    expect(spawnedEnv?.IS_SANDBOX).toBe("1");
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "ok" });
    await running;
  });

  test("keeps the original task alive through the exact interrupt event sequence", async () => {
    const fixture = transportFixture();
    let completed = false;
    const running = runClaudeTurn(
      { ...base, prompt: "ORIGINAL", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    ).then((result) => {
      completed = true;
      return result;
    });
    await Bun.sleep(0);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    const sending = sendClaudeMessage(
      { ...base, prompt: "STEERED", sessionId: SESSION_ID },
      {
        createTransport: () => {
          throw new Error("must reuse active process");
        },
      },
    );
    await Bun.sleep(0);
    const control = parseWrite(fixture, 1);
    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: control.request_id,
        response: { still_queued: [] },
      },
    };
    fixture.emit(response);
    expect((await sending).mode).toBe("steered");
    const steeredInput = parseWrite(fixture, 2).message as {
      content: Array<{ text?: string }>;
    };
    expect(steeredInput.content[0]?.text).toBe("STEERED");
    fixture.emit({
      type: "assistant",
      message: { role: "assistant", content: [] },
    });
    fixture.emit({ type: "system", subtype: "task_started" });
    fixture.emit({
      type: "result",
      is_error: true,
      terminal_reason: "aborted_streaming",
      subtype: "error_during_execution",
      result: "interrupted",
    });
    expect(completed).toBe(false);
    fixture.emit({ type: "system", subtype: "init", session_id: SESSION_ID });
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "STEERED" }],
      },
    });
    fixture.emit({
      type: "result",
      is_error: false,
      subtype: "success",
      result: "STEERED",
    });
    expect(await running).toMatchObject({ success: true, report: "STEERED" });
    expect(fixture.ended()).toBe(true);
  });

  test("awaits the matching interrupt response before accepting a steer", async () => {
    const fixture = transportFixture();
    void runClaudeTurn(
      { ...base, prompt: "original", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    let accepted = false;
    const sending = sendClaudeMessage({
      ...base,
      prompt: "steered",
      sessionId: SESSION_ID,
    }).then((receipt) => {
      accepted = true;
      return receipt;
    });
    await Bun.sleep(0);
    expect(accepted).toBe(false);
    const control = parseWrite(fixture, 1);
    fixture.emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: control.request_id,
        error: "no",
      },
    });
    expect(sending).rejects.toThrow("no");
  });

  test("final success ends stdin and completes without manual process close", async () => {
    const fixture = transportFixture();
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    fixture.emit({ type: "result", is_error: false, result: "done" });
    expect(await running).toMatchObject({ success: true, report: "done" });
    expect(fixture.ended()).toBe(true);
  });

  test(
    "keeps reading past a result while background tasks are running",
    async () => {
      const fixture = transportFixture();
      try {
        let completed = false;
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          { createTransport: () => fixture.transport },
        ).then((result) => {
          completed = true;
          return result;
        });
        await Bun.sleep(0);
        fixture.emit({
          type: "stream_event",
          event: { type: "message_start" },
        });
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: "bg1",
              run_id: "run1",
              task_type: "local_bash",
              description: "run tests",
            },
          ],
        });
        fixture.emit({
          type: "system",
          subtype: "task_started",
          task_id: "bg1",
        });
        fixture.emit({ type: "result", is_error: false, result: "WAITING" });
        await Bun.sleep(10);
        expect(completed).toBe(false);
        expect(fixture.ended()).toBe(false);

        fixture.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "bg1",
          patch: { status: "completed" },
        });
        fixture.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "bg1",
          status: "completed",
        });
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        });
        fixture.emit({
          type: "stream_event",
          event: { type: "message_start" },
        });
        fixture.emit({ type: "result", is_error: false, result: "FINISHED" });
        expect(await running).toMatchObject({
          success: true,
          report: "FINISHED",
        });
        expect(fixture.ended()).toBe(true);
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "uses the provisional result when Claude exits cleanly after background work",
    async () => {
      const fixture = transportFixture();
      try {
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          { createTransport: () => fixture.transport },
        );
        await Bun.sleep(0);
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: false, result: "WAITING" });
        await Bun.sleep(0);
        fixture.finish({ exitCode: 0, exitSignal: null });
        expect(await running).toMatchObject({
          success: true,
          report: "WAITING",
        });
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "steers directly while Claude is idle on background tasks",
    async () => {
      const fixture = transportFixture();
      try {
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          { createTransport: () => fixture.transport },
        );
        await Bun.sleep(0);
        fixture.emit({
          type: "stream_event",
          event: { type: "message_start" },
        });
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: false, result: "WAITING" });
        await Bun.sleep(0);
        const receipt = await sendClaudeMessage({
          ...base,
          prompt: "STEERED",
          sessionId: SESSION_ID,
        });
        expect(receipt.mode).toBe("steered");
        const steered = parseWrite(fixture, 1);
        expect(steered.type).toBe("user");
        expect(fixture.ended()).toBe(false);
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        });
        fixture.emit({
          type: "stream_event",
          event: { type: "message_start" },
        });
        fixture.emit({ type: "result", is_error: false, result: "STEERED" });
        expect(await running).toMatchObject({
          success: true,
          report: "STEERED",
        });
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "settles with the provisional report after the background wait cap",
    async () => {
      const fixture = transportFixture();
      try {
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          {
            createTransport: () => fixture.transport,
            backgroundTaskWaitCapMs: 20,
          },
        );
        await Bun.sleep(0);
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: false, result: "WAITING" });
        const result = await awaitWithLiveLoop(running);
        expect(result.success).toBe(true);
        expect(result.report).toStartWith("WAITING");
        expect(result.report).toContain("background tasks were still running");
        expect(fixture.ended()).toBe(true);
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "reports an errored held result as failed when the cap fires",
    async () => {
      const fixture = transportFixture();
      try {
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          {
            createTransport: () => fixture.transport,
            backgroundTaskWaitCapMs: 20,
          },
        );
        await Bun.sleep(0);
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: true, result: "BROKE" });
        const result = await awaitWithLiveLoop(running);
        expect(result.success).toBe(false);
        expect(result.report).toStartWith("BROKE");
        expect(result.report).toContain("background tasks were still running");
        expect(result.error).toStartWith("BROKE");
        expect(fixture.ended()).toBe(true);
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "ignores a result that arrives after the session settled",
    async () => {
      const fixture = transportFixture();
      const capMs = 4_321;
      const realSetTimeout = globalThis.setTimeout;
      let capTimersArmed = 0;
      globalThis.setTimeout = ((
        handler: Parameters<typeof setTimeout>[0],
        delay?: number,
        ...rest: unknown[]
      ) => {
        if (delay === capMs) capTimersArmed++;
        return realSetTimeout(handler, delay, ...rest);
      }) as typeof setTimeout;
      try {
        const running = runClaudeTurn(
          { ...base, prompt: "work", sessionId: SESSION_ID },
          {
            createTransport: () => fixture.transport,
            backgroundTaskWaitCapMs: capMs,
          },
        );
        await Bun.sleep(0);
        fixture.emit({ type: "result", is_error: false, result: "DONE" });
        const result = await running;
        expect(result).toMatchObject({ success: true, report: "DONE" });
        // Late lines flushed after settle must not re-arm the cap.
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: false, result: "LATE" });
        await Bun.sleep(10);
        expect(capTimersArmed).toBe(0);
        expect(result.report).toBe("DONE");
      } finally {
        globalThis.setTimeout = realSetTimeout;
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "cancellation while waiting on background tasks settles failed",
    async () => {
      const fixture = transportFixture();
      try {
        let aborted = false;
        fixture.transport.wasAborted = () => aborted;
        const controller = new AbortController();
        const running = runClaudeTurn(
          {
            ...base,
            prompt: "work",
            sessionId: SESSION_ID,
            signal: controller.signal,
          },
          { createTransport: () => fixture.transport },
        );
        await Bun.sleep(0);
        fixture.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash" }],
        });
        fixture.emit({ type: "result", is_error: false, result: "WAITING" });
        await Bun.sleep(0);
        aborted = true;
        controller.abort(new Error("cancelled"));
        fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
        expect(await running).toMatchObject({
          success: false,
          error: "cancelled",
          report: "WAITING",
        });
      } finally {
        teardownFixture(fixture);
      }
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test("idle concurrent sends start one resume and serialize the second steer", async () => {
    const fixture = transportFixture();
    let creates = 0;
    const deps = {
      env: { HOME: "/home/test", PATH: "/usr/bin:/bin" },
      createTransport: ({ env }: { env: NodeJS.ProcessEnv }) => {
        if (process.platform !== "win32") {
          expect(env.PATH).toBe("/usr/bin:/bin:/home/test/.local/bin");
        }
        creates++;
        return fixture.transport;
      },
    };
    const first = sendClaudeMessage(
      { ...base, prompt: "one", sessionId: SESSION_ID },
      deps,
    );
    const second = sendClaudeMessage(
      { ...base, prompt: "two", sessionId: SESSION_ID },
      deps,
    );
    expect((await first).mode).toBe("resumed");
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    await Bun.sleep(0);
    const control = parseWrite(fixture, 1);
    fixture.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: control.request_id,
        response: {},
      },
    });
    expect((await second).mode).toBe("steered");
    expect(creates).toBe(1);
    fixture.emit({
      type: "result",
      is_error: true,
      terminal_reason: "aborted_streaming",
      subtype: "error_during_execution",
    });
    fixture.emit({ type: "result", is_error: false, result: "two" });
  });

  test.each([
    {
      exitCode: 143,
      exitSignal: null,
      expected: "143; possibly out of memory",
    },
    {
      exitCode: null,
      exitSignal: "SIGTERM" as const,
      expected: "SIGTERM; possibly out of memory",
    },
    {
      exitCode: null,
      exitSignal: "SIGKILL" as const,
      expected: "SIGKILL; possibly out of memory",
    },
    { exitCode: 1, exitSignal: null, expected: "1" },
  ])(
    "reports unexpected process exit: $expected",
    async ({ exitCode, exitSignal, expected }) => {
      const fixture = transportFixture();
      const running = runClaudeTurn(
        { ...base, prompt: "one", sessionId: SESSION_ID },
        { createTransport: () => fixture.transport },
      );
      await Bun.sleep(0);
      fixture.finish({ exitCode, exitSignal });
      expect(await running).toMatchObject({
        success: false,
        error: `Claude Code exited before a final result with ${expected}`,
      });
    },
  );

  test("process close rejects an unacknowledged interrupt and permits one resume", async () => {
    const failed = transportFixture();
    const running = runClaudeTurn(
      { ...base, prompt: "one", sessionId: SESSION_ID },
      { createTransport: () => failed.transport },
    );
    await Bun.sleep(0);
    failed.emit({ type: "stream_event", event: { type: "message_start" } });
    const steering = sendClaudeMessage({
      ...base,
      prompt: "two",
      sessionId: SESSION_ID,
    });
    const steeringFailure = steering.catch((error: unknown) => error);
    await Bun.sleep(0);
    failed.stderr.write("boom");
    failed.finish({ exitCode: 1, exitSignal: null });
    await Bun.sleep(0);
    expect(await steeringFailure).toBeInstanceOf(Error);
    expect(await running).toMatchObject({
      success: false,
      error: expect.stringContaining("boom"),
    });
    const resumed = transportFixture();
    const next = await sendClaudeMessage(
      { ...base, prompt: "three", sessionId: SESSION_ID },
      { createTransport: () => resumed.transport },
    );
    expect(next.mode).toBe("resumed");
    resumed.emit({ type: "result", is_error: false, result: "three" });
  });

  test("waits for a replacement result when the old turn wins the interrupt race", async () => {
    const fixture = transportFixture();
    let completed = false;
    const running = runClaudeTurn(
      { ...base, prompt: "old", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    ).then((result) => {
      completed = true;
      return result;
    });
    await Bun.sleep(0);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    const steering = sendClaudeMessage({
      ...base,
      prompt: "new",
      sessionId: SESSION_ID,
    });
    await Bun.sleep(0);
    const control = parseWrite(fixture, 1);
    fixture.emit({ type: "result", is_error: false, result: "old" });
    expect(completed).toBe(false);
    fixture.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: control.request_id,
        response: {},
      },
    });
    expect((await steering).mode).toBe("steered");
    fixture.emit({ type: "result", is_error: false, result: "new" });
    expect(await running).toMatchObject({ success: true, report: "new" });
  });

  test("waits for an interruptible turn and handles a missing aborted result", async () => {
    const fixture = transportFixture();
    const running = runClaudeTurn(
      { ...base, prompt: "old", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    const steering = sendClaudeMessage({
      ...base,
      prompt: "new",
      sessionId: SESSION_ID,
    });
    await Bun.sleep(0);
    expect(fixture.writes).toHaveLength(1);

    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    await Bun.sleep(0);
    const control = parseWrite(fixture, 1);
    fixture.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: control.request_id,
        response: {},
      },
    });
    expect((await steering).mode).toBe("steered");
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "new" });
    expect(await running).toMatchObject({ success: true, report: "new" });
  });

  test("tracked resume interruption aborts its managed process", async () => {
    const fixture = transportFixture();
    let aborted = false;
    const receipt = await sendClaudeMessage(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      {
        createTransport: (options) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              fixture.transport.wasAborted = () => true;
              fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
            },
            { once: true },
          );
          return fixture.transport;
        },
      },
    );
    await receipt.interrupt?.();
    expect(aborted).toBe(true);
    expect(await receipt.completion).toMatchObject({ success: false });
  });

  test("startup write failure aborts and awaits the child process", async () => {
    const fixture = transportFixture();
    let aborted = false;
    fixture.stdin.write = ((
      _chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      queueMicrotask(() => callback?.(new Error("write failed")));
      return false;
    }) as typeof fixture.stdin.write;
    const result = await runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      {
        createTransport: (options) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              fixture.transport.wasAborted = () => true;
              fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
            },
            { once: true },
          );
          return fixture.transport;
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("write failed"),
    });
    expect(aborted).toBe(true);
  });

  test("replacement write failure aborts after an acknowledged interrupt", async () => {
    const fixture = transportFixture();
    const originalWrite = fixture.stdin.write;
    let failWrites = false;
    fixture.stdin.write = function (
      this: typeof fixture.stdin,
      ...args: Parameters<typeof fixture.stdin.write>
    ) {
      if (!failWrites) return Reflect.apply(originalWrite, this, args);
      const callback = [...args]
        .reverse()
        .find((value) => typeof value === "function") as
        | ((error?: Error | null) => void)
        | undefined;
      queueMicrotask(() => callback?.(new Error("replacement write failed")));
      return false;
    } as typeof fixture.stdin.write;
    let aborted = false;
    const running = runClaudeTurn(
      { ...base, prompt: "old", sessionId: SESSION_ID },
      {
        createTransport: (options) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              fixture.transport.wasAborted = () => true;
              fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
            },
            { once: true },
          );
          return fixture.transport;
        },
      },
    );
    await Bun.sleep(0);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    const steering = sendClaudeMessage({
      ...base,
      prompt: "new",
      sessionId: SESSION_ID,
    });
    await Bun.sleep(0);
    const control = parseWrite(fixture, 1);
    failWrites = true;
    fixture.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: control.request_id,
        response: {},
      },
    });
    expect(steering).rejects.toThrow();
    expect(await running).toMatchObject({ success: false });
    expect(aborted).toBe(true);
  });

  test("emits one tool call per assistant tool_use block", async () => {
    const fixture = transportFixture();
    const calls: Array<{ id: string; name: string; args: string }> = [];
    const running = runClaudeTurn(
      {
        ...base,
        prompt: "work",
        sessionId: SESSION_ID,
        onToolCall: (call) => calls.push(call),
      },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    const toolUse = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Write",
            input: { file_path: "a.txt", content: "x".repeat(2_000) },
          },
        ],
      },
    };
    fixture.emit(toolUse);
    // Claude Code can repeat an assistant message; each block counts once.
    fixture.emit(toolUse);
    fixture.emit({
      type: "result",
      is_error: false,
      subtype: "success",
      result: "done",
    });
    expect(await running).toMatchObject({ success: true });
    expect(calls.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "toolu_1", name: "Bash" },
      { id: "toolu_2", name: "Write" },
    ]);
    expect(calls[0]?.args).toBe('{"command":"ls"}');
    expect(calls[1]?.args.length).toBeLessThanOrEqual(1_001);
    expect(calls[1]?.args.endsWith("…")).toBe(true);
  });

  test("cancellation still reaches a settled session whose process is alive", async () => {
    const fixture = transportFixture({ exitOnStdinEnd: false });
    let killed = false;
    const controller = new AbortController();
    const result = await (async () => {
      const running = runClaudeTurn(
        {
          ...base,
          prompt: "work",
          sessionId: SESSION_ID,
          signal: controller.signal,
        },
        {
          createTransport: (options) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                killed = true;
                fixture.transport.wasAborted = () => true;
                fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
              },
              { once: true },
            );
            return fixture.transport;
          },
        },
      );
      await Bun.sleep(0);
      fixture.emit({ type: "result", is_error: false, result: "done" });
      return running;
    })();
    expect(result).toMatchObject({ success: true, report: "done" });
    expect(fixture.ended()).toBe(true);
    expect(hasActiveClaudeTurn(SESSION_ID)).toBe(false);

    controller.abort(new Error("stopped"));
    expect(killed).toBe(true);
  });

  test("resume waits for a settled session's live process instead of spawning a second", async () => {
    const first = transportFixture({ exitOnStdinEnd: false });
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      { createTransport: () => first.transport },
    );
    await Bun.sleep(0);
    first.emit({ type: "result", is_error: false, result: "done" });
    expect(await running).toMatchObject({ success: true, report: "done" });

    const second = transportFixture();
    let creates = 0;
    const sending = sendClaudeMessage(
      { ...base, prompt: "next", sessionId: SESSION_ID },
      {
        createTransport: () => {
          creates++;
          return second.transport;
        },
      },
    );
    await Bun.sleep(10);
    expect(creates).toBe(0);

    first.finish({ exitCode: 0, exitSignal: null });
    const receipt = await sending;
    expect(receipt.mode).toBe("resumed");
    expect(creates).toBe(1);
    second.emit({ type: "result", is_error: false, result: "next" });
    expect(await receipt.completion).toMatchObject({
      success: true,
      report: "next",
    });
  });

  test("resume stops a settled process that outlives the exit grace period", async () => {
    const first = transportFixture({ exitOnStdinEnd: false });
    let killed = false;
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      {
        createTransport: (options) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              killed = true;
              first.finish({ exitCode: null, exitSignal: "SIGTERM" });
            },
            { once: true },
          );
          return first.transport;
        },
      },
    );
    await Bun.sleep(0);
    first.emit({ type: "result", is_error: false, result: "done" });
    await running;

    const second = transportFixture();
    let creates = 0;
    const receipt = await sendClaudeMessage(
      { ...base, prompt: "next", sessionId: SESSION_ID },
      {
        settledExitGraceMs: 10,
        createTransport: () => {
          creates++;
          expect(killed).toBe(true);
          return second.transport;
        },
      },
    );
    expect(receipt.mode).toBe("resumed");
    expect(creates).toBe(1);
  });

  test("concurrent resumes behind an exiting process start only one", async () => {
    const first = transportFixture({ exitOnStdinEnd: false });
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      { createTransport: () => first.transport },
    );
    await Bun.sleep(0);
    first.emit({ type: "result", is_error: false, result: "done" });
    await running;

    const next = transportFixture();
    let creates = 0;
    const deps = {
      createTransport: () => {
        creates++;
        return next.transport;
      },
    };
    const one = sendClaudeMessage(
      { ...base, prompt: "one", sessionId: SESSION_ID },
      deps,
    );
    const two = sendClaudeMessage(
      { ...base, prompt: "two", sessionId: SESSION_ID },
      deps,
    );
    await Bun.sleep(0);
    first.finish({ exitCode: 0, exitSignal: null });
    expect((await one).mode).toBe("resumed");
    next.emit({ type: "stream_event", event: { type: "message_start" } });
    await Bun.sleep(0);
    const control = parseWrite(next, 1);
    next.emit({
      type: "control_response",
      response: { subtype: "success", request_id: control.request_id },
    });
    expect((await two).mode).toBe("steered");
    expect(creates).toBe(1);
  });

  test("a background-completion result does not settle a newer input", async () => {
    const fixture = transportFixture();
    let completed = false;
    const running = runClaudeTurn(
      { ...base, prompt: "work", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    ).then((result) => {
      completed = true;
      return result;
    });
    await Bun.sleep(0);
    fixture.echo(0);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bg1", task_type: "local_bash" }],
    });
    fixture.emit({ type: "result", is_error: false, result: "STARTED" });
    await Bun.sleep(0);

    const receipt = await sendClaudeMessage({
      ...base,
      prompt: "FOLLOW-UP",
      sessionId: SESSION_ID,
    });
    expect(receipt.mode).toBe("steered");

    // The background task finishes and Claude runs its own wake-up turn
    // before it picks up the follow-up.
    fixture.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "" });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    expect(fixture.ended()).toBe(false);

    fixture.echo(1);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "ANSWER" });
    expect(await running).toMatchObject({ success: true, report: "ANSWER" });
  });

  test("a stray result before a resumed input starts does not settle it empty", async () => {
    const fixture = transportFixture();
    const receipt = await sendClaudeMessage(
      { ...base, prompt: "first", sessionId: SESSION_ID },
      { createTransport: () => fixture.transport },
    );
    expect(receipt.mode).toBe("resumed");
    fixture.emit({
      type: "command_lifecycle",
      command_uuid: parseWrite(fixture, 0).uuid,
      state: "started",
    });
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bg1", task_type: "local_bash" }],
    });
    fixture.emit({ type: "result", is_error: false, result: "WAITING" });
    await Bun.sleep(0);
    await sendClaudeMessage({
      ...base,
      prompt: "second",
      sessionId: SESSION_ID,
    });
    let completed = false;
    void receipt.completion?.then(() => {
      completed = true;
    });
    fixture.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    fixture.emit({ type: "result", is_error: false, result: "" });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    fixture.emit({
      type: "command_lifecycle",
      command_uuid: parseWrite(fixture, 1).uuid,
      state: "started",
    });
    fixture.emit({ type: "result", is_error: false, result: "second" });
    expect(await receipt.completion).toMatchObject({
      success: true,
      report: "second",
    });
  });

  test("cancellation settles failed and evicts the session", async () => {
    const fixture = transportFixture();
    let aborted = false;
    fixture.transport.wasAborted = () => aborted;
    const controller = new AbortController();
    const running = runClaudeTurn(
      {
        ...base,
        prompt: "work",
        sessionId: SESSION_ID,
        signal: controller.signal,
      },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    aborted = true;
    controller.abort(new Error("cancelled"));
    fixture.finish({ exitCode: null, exitSignal: "SIGINT" });
    expect(await running).toMatchObject({ success: false, error: "cancelled" });
  });
});
