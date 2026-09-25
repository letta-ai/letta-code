import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetClaudeSessionsForTests,
  type ClaudeSessionTransport,
  runClaudeTurn,
  sendClaudeMessage,
} from "./claude-stream-session";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function transportFixture() {
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
  stdin.on("finish", () => finish({ exitCode: 0, exitSignal: null }));
  const transport: ClaudeSessionTransport = {
    process: { stdin, stdout, stderr } as ClaudeSessionTransport["process"],
    completion,
    wasAborted: () => false,
  };
  const emit = (value: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify(value)}\n`);
  return {
    transport,
    writes,
    stdout,
    stderr,
    finish,
    stdin,
    emit,
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

afterEach(() => __resetClaudeSessionsForTests());

describe("Claude stream sessions", () => {
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

  test("idle concurrent sends start one resume and serialize the second steer", async () => {
    const fixture = transportFixture();
    let creates = 0;
    const deps = {
      createTransport: () => {
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
