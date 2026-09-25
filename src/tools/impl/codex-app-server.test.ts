import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetCodexSessionsForTests,
  type CodexAppServerTransport,
  sendCodexMessage,
  startCodexTurn,
} from "./codex-app-server";

class FakeCodexTransport {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  private threadId = "thread-1";
  private turnId = "turn-1";
  steerRace = false;
  completeBeforeTurnStartSettles = false;
  initializeError = false;
  killed = false;

  constructor() {
    let buffered = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line) this.handle(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  transport(): CodexAppServerTransport {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: () => {
        this.killed = true;
      },
    };
  }

  complete(text = "done", items = true): void {
    if (!items) {
      this.send({
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId: this.turnId,
          item: { type: "agentMessage", text },
        },
      });
    }
    this.send({
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turn: {
          id: this.turnId,
          status: "completed",
          items: items ? [{ type: "agentMessage", text }] : [],
        },
      },
    });
  }

  private handle(request: Record<string, unknown>): void {
    this.requests.push(request);
    if (typeof request.id !== "number") return;
    const method = request.method;
    if (method === "initialize") {
      if (this.initializeError) {
        this.send({ id: request.id, error: { message: "initialize failed" } });
      } else {
        this.reply(request.id, {});
      }
    }
    if (method === "thread/start" || method === "thread/resume") {
      const params = request.params as Record<string, unknown>;
      if (typeof params.threadId === "string") this.threadId = params.threadId;
      this.reply(request.id, { thread: { id: this.threadId } });
    }
    if (method === "turn/start") {
      this.reply(request.id, {
        turn: { id: this.turnId, status: "inProgress", items: [] },
      });
      if (this.completeBeforeTurnStartSettles) {
        this.complete("fast completion", false);
      }
    }
    if (method === "turn/steer") {
      if (this.steerRace) {
        this.complete("first turn done");
        this.turnId = "turn-2";
        this.send({
          id: request.id,
          error: { message: "active turn changed" },
        });
      } else {
        this.reply(request.id, { turnId: this.turnId });
      }
    }
    if (method === "turn/interrupt") this.reply(request.id, {});
  }

  private reply(id: number, result: Record<string, unknown>): void {
    this.send({ id, result });
  }

  close(detail = "transport died"): void {
    this.stderr.write(detail);
    this.stdout.end();
  }

  private send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

afterEach(() => __resetCodexSessionsForTests());

describe("Codex app-server lifecycle", () => {
  test("starts a native thread and turn, then resolves completion", async () => {
    const fake = new FakeCodexTransport();
    let started: string | undefined;
    const handle = await startCodexTurn(
      {
        prompt: "Implement it",
        parentAgentId: "parent",
        cwd: "/repo",
        onStarted: (threadId) => {
          started = threadId;
        },
      },
      { createTransport: () => fake.transport() },
    );
    expect(handle.threadId).toBe("thread-1");
    expect(started).toBe("thread-1");
    expect(fake.requests.map((request) => request.method)).toContain(
      "turn/start",
    );
    fake.complete("finished");
    expect(await handle.completion).toMatchObject({
      agentId: "codex_thread-1",
      runtimeSessionId: "thread-1",
      report: "finished",
      success: true,
    });
  });

  test("uses item/completed agent text when turn/completed items are empty", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    fake.complete("real final text", false);
    expect(await handle.completion).toMatchObject({
      report: "real final text",
      success: true,
    });
  });

  test("replays completion that arrives before turn/start settles", async () => {
    const fake = new FakeCodexTransport();
    fake.completeBeforeTurnStartSettles = true;
    const handle = await startCodexTurn(
      { prompt: "Fast", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    expect(await handle.completion).toMatchObject({
      report: "fast completion",
      success: true,
    });
  });

  test("disposes the transport when initialize fails", async () => {
    const fake = new FakeCodexTransport();
    fake.initializeError = true;
    await expect(
      startCodexTurn(
        { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
        { createTransport: () => fake.transport() },
      ),
    ).rejects.toThrow("initialize failed");
    expect(fake.killed).toBe(true);
  });

  test("fails active completion and evicts the session when stdout closes", async () => {
    const first = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => first.transport() },
    );
    first.close("boom");
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
      { createTransport: () => second.transport() },
    );
    expect(second.requests.map((request) => request.method)).toContain(
      "thread/resume",
    );
  });

  test("routes messages to active turns through turn/steer", async () => {
    const fake = new FakeCodexTransport();
    await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    const receipt = await sendCodexMessage({
      threadId: "thread-1",
      prompt: "Steer now",
      parentAgentId: "parent",
      cwd: "/repo",
    });
    expect(receipt.mode).toBe("steered");
    expect(fake.requests.map((request) => request.method)).toContain(
      "turn/steer",
    );
    expect(fake.requests.map((request) => request.method)).not.toContain(
      "codex exec resume",
    );
  });

  test("falls back exactly once when completion races steering rejection", async () => {
    const fake = new FakeCodexTransport();
    await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    fake.steerRace = true;
    const receipt = await sendCodexMessage({
      threadId: "thread-1",
      prompt: "Do not drop this",
      parentAgentId: "parent",
      cwd: "/repo",
    });
    expect(receipt.mode).toBe("new_turn");
    expect(
      fake.requests.filter((request) => request.method === "turn/steer"),
    ).toHaveLength(1);
    expect(
      fake.requests.filter((request) => request.method === "turn/start"),
    ).toHaveLength(2);
  });

  test("serializes concurrent idle messages and steers the second", async () => {
    const fake = new FakeCodexTransport();
    const initial = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    fake.complete("initial done");
    await initial.completion;
    const receipts = await Promise.all([
      sendCodexMessage({
        threadId: "thread-1",
        prompt: "First",
        parentAgentId: "parent",
        cwd: "/repo",
      }),
      sendCodexMessage({
        threadId: "thread-1",
        prompt: "Second",
        parentAgentId: "parent",
        cwd: "/repo",
      }),
    ]);
    expect(receipts.map((receipt) => receipt.mode)).toEqual([
      "new_turn",
      "steered",
    ]);
  });

  test("disposes idle sessions and resumes them on the next message", async () => {
    const first = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => first.transport(), idleTimeoutMs: 1 },
    );
    first.complete("done");
    await handle.completion;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first.killed).toBe(true);

    const second = new FakeCodexTransport();
    await sendCodexMessage(
      {
        threadId: "thread-1",
        prompt: "Continue",
        parentAgentId: "parent",
        cwd: "/repo",
      },
      { createTransport: () => second.transport() },
    );
    expect(second.requests.map((request) => request.method)).toContain(
      "thread/resume",
    );
  });

  test("does not duplicate MCP reminder in the initial user prompt", async () => {
    const fake = new FakeCodexTransport();
    await startCodexTurn(
      {
        prompt: "Implement it",
        parentAgentId: "parent",
        cwd: "/repo",
        mcpReminder: "MCP reminder",
      },
      { createTransport: () => fake.transport() },
    );
    const threadStart = fake.requests.find(
      (request) => request.method === "thread/start",
    );
    const turnStart = fake.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(threadStart?.params).toMatchObject({
      developerInstructions: "MCP reminder",
    });
    expect(turnStart?.params).toMatchObject({
      input: [{ type: "text", text: "Implement it" }],
      sandboxPolicy: { networkAccess: true },
    });
  });

  test("interrupts the active turn on cancellation", async () => {
    const fake = new FakeCodexTransport();
    const controller = new AbortController();
    await startCodexTurn(
      {
        prompt: "Initial",
        parentAgentId: "parent",
        cwd: "/repo",
        signal: controller.signal,
      },
      { createTransport: () => fake.transport() },
    );
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.requests.map((request) => request.method)).toContain(
      "turn/interrupt",
    );
  });
});
