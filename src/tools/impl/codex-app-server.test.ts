import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  __resetCodexSessionsForTests,
  CODEX_NOT_SIGNED_IN_ERROR,
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
  account: Record<string, unknown> | null = {
    account: { type: "chatgpt" },
    requiresOpenaiAuth: true,
  };
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
    if (method === "account/read") {
      if (this.account) this.reply(request.id, this.account);
      else this.send({ id: request.id, error: { message: "unknown method" } });
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

  item(
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
  ): void {
    this.send({
      method,
      params: { threadId: this.threadId, turnId: this.turnId, item },
    });
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
    let admitted: string | undefined;
    const handle = await startCodexTurn(
      {
        prompt: "Implement it",
        parentAgentId: "parent",
        cwd: "/repo",
        beforeStart: async (threadId) => {
          admitted = threadId;
          expect(fake.requests.map((request) => request.method)).not.toContain(
            "turn/start",
          );
        },
        onStarted: (threadId) => {
          started = threadId;
        },
      },
      { createTransport: () => fake.transport() },
    );
    expect(handle.threadId).toBe("thread-1");
    expect(admitted).toBe("thread-1");
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

  test("emits each tool-like item once as a tool call", async () => {
    const fake = new FakeCodexTransport();
    const calls: Array<{ id: string; name: string; args: string }> = [];
    const handle = await startCodexTurn(
      {
        prompt: "Work",
        parentAgentId: "parent",
        cwd: "/repo",
        onToolCall: (call) => calls.push(call),
      },
      { createTransport: () => fake.transport() },
    );
    const command = {
      type: "commandExecution",
      id: "cmd-1",
      command: "bun test",
      status: "inProgress",
    };
    fake.item("item/started", command);
    fake.item("item/completed", { ...command, status: "completed" });
    fake.item("item/started", {
      type: "fileChange",
      id: "patch-1",
      changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "" }],
      status: "inProgress",
    });
    fake.item("item/started", {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "linear",
      tool: "get_issue",
      arguments: { id: "LET-1" },
      status: "inProgress",
    });
    // Web search carries its query only once it completes.
    fake.item("item/started", { type: "webSearch", id: "ws-1", query: "" });
    fake.item("item/completed", {
      type: "webSearch",
      id: "ws-1",
      query: "bun test",
    });
    fake.item("item/started", { type: "reasoning", id: "r-1", summary: [] });
    fake.item("item/started", { type: "agentMessage", id: "m-1", text: "" });
    fake.complete("done");
    await handle.completion;
    expect(calls).toEqual([
      { id: "cmd-1", name: "Bash", args: '{"command":"bun test"}' },
      { id: "patch-1", name: "Edit", args: '{"files":["src/a.ts"]}' },
      { id: "mcp-1", name: "linear/get_issue", args: '{"id":"LET-1"}' },
      { id: "ws-1", name: "WebSearch", args: '{"query":"bun test"}' },
    ]);
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

  test("fails before starting a thread when Codex needs an OpenAI sign-in", async () => {
    const fake = new FakeCodexTransport();
    fake.account = { account: null, requiresOpenaiAuth: true };
    await expect(
      startCodexTurn(
        { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
        { createTransport: () => fake.transport() },
      ),
    ).rejects.toThrow(CODEX_NOT_SIGNED_IN_ERROR);
    expect(fake.requests.map((request) => request.method)).not.toContain(
      "thread/start",
    );
    expect(fake.killed).toBe(true);
  });

  test.each([
    [
      "a provider that needs no OpenAI login (managed proxy)",
      {
        account: null,
        requiresOpenaiAuth: false,
      },
    ],
    ["a Codex without account/read", null],
  ])("starts the turn for %s", async (_label, account) => {
    const fake = new FakeCodexTransport();
    fake.account = account;
    const handle = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    fake.complete();
    expect(await handle.completion).toMatchObject({ success: true });
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
        { createTransport: () => ({ ...fake.transport(), exited }) },
      );
      fake.close(detail);
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolveExit({ code, signal });
      expect(await handle.completion).toMatchObject({
        success: false,
        error: `Codex app-server closed${expected}`,
      });
    },
  );

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

  test.each([false, true])(
    "passes MCP reminder to new and resumed threads without duplicating user text (resume=%s)",
    async (resume) => {
      const fake = new FakeCodexTransport();
      await startCodexTurn(
        {
          prompt: "Implement it",
          parentAgentId: "parent",
          cwd: "/repo",
          mcpReminder: "MCP reminder",
          ...(resume ? { resumeThreadId: "thread-1" } : {}),
        },
        { createTransport: () => fake.transport() },
      );
      const threadStart = fake.requests.find(
        (request) =>
          request.method === (resume ? "thread/resume" : "thread/start"),
      );
      const turnStart = fake.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(threadStart?.params).toMatchObject({
        developerInstructions: "MCP reminder",
      });
      expect(turnStart?.params).toMatchObject({
        input: [{ type: "text", text: "Implement it" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      if (!resume) {
        expect(threadStart?.params).toMatchObject({
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
      }
    },
  );

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
