import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetClaudeSessionsForTests,
  buildClaudeStreamArgs,
  runClaudeTurn,
  sendClaudeMessage,
} from "./claude-stream-session";
import {
  awaitWithLiveLoop,
  BACKGROUND_TEST_TIMEOUT_MS,
  base,
  parseWrite,
  SESSION_ID,
  teardownFixture,
  teardownOpenFixtures,
  transportFixture,
} from "./claude-stream-session.test-helpers";

afterEach(() => {
  teardownOpenFixtures();
  __resetClaudeSessionsForTests();
});

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

  test("reports assistant text and tool_use blocks in stream order", async () => {
    const fixture = transportFixture();
    const events: string[] = [];
    const running = runClaudeTurn(
      {
        ...base,
        prompt: "work",
        sessionId: SESSION_ID,
        onText: (text) => events.push(`text:${text}`),
        onToolCall: (call) => events.push(`tool:${call.name}`),
      },
      { createTransport: () => fixture.transport },
    );
    await Bun.sleep(0);
    const text = {
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "Chat suite finished; continuing to wait." },
          { type: "text", text: "  " },
        ],
      },
    };
    fixture.emit(text);
    // A repeated message reports its text once.
    fixture.emit(text);
    fixture.emit({
      type: "assistant",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          { type: "text", text: "Tests passed." },
        ],
      },
    });
    fixture.emit({ type: "result", is_error: false, result: "done" });
    expect(await running).toMatchObject({ success: true });
    expect(events).toEqual([
      "text:Chat suite finished; continuing to wait.",
      "tool:Bash",
      "text:Tests passed.",
    ]);
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
