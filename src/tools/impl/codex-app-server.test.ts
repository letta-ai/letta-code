import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { settingsManager } from "@/settings-manager";
import {
  __resetCodexSessionsForTests,
  CODEX_NOT_SIGNED_IN_ERROR,
  listCodexModels,
  sendCodexMessage,
  startCodexTurn,
  stopCodexSession,
} from "./codex-app-server";
import { CODEX_CAPACITY_ERROR } from "./codex-app-server-payloads";
import { CAPACITY_MESSAGE, FakeCodexTransport } from "./codex-test-transport";
import { runExternalCodingAgent } from "./external-coding-agent";
import { clearNativeSessionCaptureForTests } from "./native-session-capture";

beforeAll(() => settingsManager.initialize());
afterEach(() => __resetCodexSessionsForTests());

describe("Codex app-server requests", () => {
  test.each([
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["item/tool/requestUserInput", { answers: {} }],
    [
      "mcpServer/elicitation/request",
      { action: "decline", content: null, _meta: null },
    ],
    [
      "applyPatchApproval",
      { decision: { denied: { rejection: "Approvals are disabled" } } },
    ],
    [
      "execCommandApproval",
      { decision: { denied: { rejection: "Approvals are disabled" } } },
    ],
    ["item/tool/call", { success: false, contentItems: [] }],
  ])("answers %s with the protocol result", async (method, result) => {
    const fake = new FakeCodexTransport();
    fake.onInitialize = () => fake.send({ id: "server-1", method, params: {} });
    await startCodexTurn(
      { prompt: "work", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    expect(fake.requests).toContainEqual({ id: "server-1", result });
  });

  test.each(["account/chatgptAuthTokens/refresh", "attestation/generate"])(
    "returns a protocol error for unsupported %s",
    async (method) => {
      const fake = new FakeCodexTransport();
      fake.onInitialize = () => fake.send({ id: "server-2", method });
      await startCodexTurn(
        { prompt: "work", parentAgentId: "parent", cwd: "/repo" },
        { createTransport: () => fake.transport() },
      );
      expect(fake.requests).toContainEqual({
        id: "server-2",
        error: {
          code: -32601,
          message: `Unsupported Codex request: ${method}`,
        },
      });
    },
  );

  test("answers currentTime/read in whole Unix seconds", async () => {
    const fake = new FakeCodexTransport();
    fake.onInitialize = () =>
      fake.send({ id: "clock", method: "currentTime/read" });
    const before = Math.floor(Date.now() / 1_000);
    await startCodexTurn(
      { prompt: "work", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    const result = fake.requests.find(({ id }) => id === "clock")?.result;
    const time = (result as { currentTimeAt: number } | undefined)
      ?.currentTimeAt;
    expect(Number.isInteger(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000));
  });

  test("answers an unknown request without settling a client request with the same ID", async () => {
    const fake = new FakeCodexTransport();
    fake.initializeError = true;
    fake.onInitialize = (id) =>
      fake.send({ id, method: "future/request", params: {} });
    await expect(
      startCodexTurn(
        { prompt: "work", parentAgentId: "parent", cwd: "/repo" },
        { createTransport: () => fake.transport() },
      ),
    ).rejects.toThrow("initialize failed");
    expect(fake.requests).toContainEqual({
      id: 1,
      error: {
        code: -32601,
        message: "Unsupported Codex request: future/request",
      },
    });
    expect(fake.requests.some(({ method }) => method === "initialized")).toBe(
      false,
    );
  });
});

test("registers Codex repository skills before thread startup", async () => {
  const fake = new FakeCodexTransport();
  const options = {
    prompt: "Work",
    parentAgentId: "p",
    cwd: "/",
    cloudSkillRepositories: ["api"],
  };
  await startCodexTurn(options, { createTransport: () => fake.transport() });
  const [roots, thread] = fake.requests.slice(-3, -1);
  expect(roots?.method).toBe("skills/extraRoots/set");
  expect(roots?.params).toEqual({
    extraRoots: [join("/root/workspace", "api", ".agents", "skills")],
  });
  expect(thread?.method).toBe("thread/start");
});
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
        onToolCall: ({ input: _, ...call }) => calls.push(call),
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

  test("reports each completed agent message once as text", async () => {
    const fake = new FakeCodexTransport();
    const events: string[] = [];
    const handle = await startCodexTurn(
      {
        prompt: "Work",
        parentAgentId: "parent",
        cwd: "/repo",
        onText: (text) => events.push(`text:${text}`),
        onToolCall: (call) => events.push(`tool:${call.name}`),
      },
      { createTransport: () => fake.transport() },
    );
    const message = { type: "agentMessage", id: "m-1", text: "Running tests." };
    fake.item("item/started", { ...message, text: "" });
    fake.item("item/completed", message);
    fake.item("item/completed", message);
    fake.item("item/started", {
      type: "commandExecution",
      id: "cmd-1",
      command: "bun test",
      status: "inProgress",
    });
    fake.complete("done");
    await handle.completion;
    expect(events).toEqual(["text:Running tests.", "tool:Bash"]);
  });

  test("reports completed command output, exit code, and reasoning", async () => {
    const fake = new FakeCodexTransport();
    const events: unknown[] = [];
    const handle = await startCodexTurn(
      {
        prompt: "Work",
        parentAgentId: "parent",
        cwd: "/repo",
        onToolResult: (result) => events.push(result),
        onReasoning: (text) => events.push(`reasoning:${text}`),
      },
      { createTransport: () => fake.transport() },
    );
    const command = { type: "commandExecution", id: "cmd-1", command: "t" };
    fake.item("item/started", { ...command, status: "inProgress" });
    fake.item("item/completed", {
      ...command,
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "FAIL test_parse_hours",
    });
    fake.item("item/completed", { type: "reasoning", summary: ["Check 3."] });
    fake.complete("done");
    await handle.completion;
    expect(events).toEqual([
      {
        id: "cmd-1",
        isError: true,
        output: "FAIL test_parse_hours\n[exit code 1]",
      },
      "reasoning:Check 3.",
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

  test("keeps the launch model on live and cold follow-ups", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-resume-model-"));
    const previous = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = directory;
    const model = "gpt-5.4";
    const first = new FakeCodexTransport();
    first.onTurnStarted = () => first.complete();
    const followup = {
      threadId: "thread-1",
      prompt: "Continue",
      parentAgentId: "parent",
      cwd: directory,
    };
    try {
      const launch = await runExternalCodingAgent(
        {
          type: "codex",
          prompt: "Initial",
          parentAgentId: "parent",
          parentConversationId: "conversation",
          cwd: directory,
          model,
        },
        {
          env: {},
          resolveSecretEnv: async () => ({}),
          runPreflight: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          runCodexTurn: async (options) => {
            const handle = await startCodexTurn(options, {
              createTransport: () => first.transport(),
            });
            return handle.completion;
          },
        },
      );
      expect(launch).toMatchObject({ success: true, model });

      const live = await sendCodexMessage(followup);
      expect(await live.completion).toMatchObject({ success: true, model });

      __resetCodexSessionsForTests();
      const second = new FakeCodexTransport();
      second.onTurnStarted = () => second.complete();
      const cold = await sendCodexMessage(followup, {
        createTransport: () => second.transport(),
      });
      expect(
        second.requests.find(({ method }) => method === "thread/resume"),
      ).toMatchObject({ params: { threadId: followup.threadId, model } });
      expect(
        second.requests.find(({ method }) => method === "turn/start"),
      ).toMatchObject({ params: { threadId: followup.threadId, model } });
      expect(await cold.completion).toMatchObject({ success: true, model });
    } finally {
      await clearNativeSessionCaptureForTests();
      if (previous === undefined) delete process.env.LETTA_CONFIG_DIR;
      else process.env.LETTA_CONFIG_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
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

describe("Codex capacity failures", () => {
  function turnStarts(fake: FakeCodexTransport) {
    return fake.requests.filter((request) => request.method === "turn/start");
  }

  test("retries a 409 capacity failure with backoff before any tool ran", async () => {
    const fake = new FakeCodexTransport();
    fake.failNextTurns = 2;
    fake.completeAfterFailures = "recovered";
    const delays: number[] = [];
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      {
        createTransport: () => fake.transport(),
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(await handle.completion).toMatchObject({
      success: true,
      report: "recovered",
    });
    expect(delays).toEqual([1_000, 2_000]);
    const starts = turnStarts(fake);
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      expect(start.params).toMatchObject({
        threadId: "thread-1",
        input: [{ type: "text", text: "Implement it" }],
      });
    }
  });

  test("does not report text again when a retried attempt repeats it", async () => {
    const fake = new FakeCodexTransport();
    const texts: string[] = [];
    const handle = await startCodexTurn(
      {
        prompt: "Implement it",
        parentAgentId: "parent",
        cwd: "/repo",
        onText: (text) => texts.push(text),
      },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    fake.item("item/completed", {
      type: "agentMessage",
      id: "m-1",
      text: "Checking the repo.",
    });
    fake.onTurnStarted = () => {
      fake.item("item/completed", {
        type: "agentMessage",
        id: "m-2",
        text: "Checking the repo.",
      });
      fake.item("item/completed", {
        type: "agentMessage",
        id: "m-3",
        text: "Tests pass.",
      });
      fake.complete("Tests pass.");
    };
    fake.fail();
    expect(await handle.completion).toMatchObject({ success: true });
    expect(turnStarts(fake)).toHaveLength(2);
    expect(texts).toEqual(["Checking the repo.", "Tests pass."]);
  });

  test("explains the capacity failure after the last retry", async () => {
    const fake = new FakeCodexTransport();
    fake.failNextTurns = 3;
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    const result = await handle.completion;
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(CODEX_CAPACITY_ERROR);
    expect(result.error).toContain("409 Conflict");
    expect(turnStarts(fake)).toHaveLength(3);
  });

  test("does not retry once a tool item has run in the turn", async () => {
    const fake = new FakeCodexTransport();
    let slept = false;
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      {
        createTransport: () => fake.transport(),
        sleep: async () => {
          slept = true;
        },
      },
    );
    fake.item("item/started", {
      type: "commandExecution",
      id: "cmd-1",
      command: "touch file",
      status: "inProgress",
    });
    fake.fail();
    const result = await handle.completion;
    expect(result.error).toStartWith(CODEX_CAPACITY_ERROR);
    expect(slept).toBe(false);
    expect(turnStarts(fake)).toHaveLength(1);
  });

  test("stops retrying when the turn is cancelled during backoff", async () => {
    const fake = new FakeCodexTransport();
    fake.failNextTurns = 3;
    const controller = new AbortController();
    const handle = await startCodexTurn(
      {
        prompt: "Implement it",
        parentAgentId: "parent",
        cwd: "/repo",
        signal: controller.signal,
      },
      {
        createTransport: () => fake.transport(),
        sleep: async () => controller.abort(),
      },
    );
    const result = await handle.completion;
    expect(result.error).toStartWith(CODEX_CAPACITY_ERROR);
    expect(turnStarts(fake)).toHaveLength(1);
  });

  test("interrupting a follow-up turn targets the retry and stops further retries", async () => {
    const fake = new FakeCodexTransport();
    const initial = await startCodexTurn(
      { prompt: "Initial", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport() },
    );
    fake.complete("initial done");
    await initial.completion;
    fake.failNextTurns = 2;
    const receipt = await sendCodexMessage({
      threadId: "thread-1",
      prompt: "Follow up",
      parentAgentId: "parent",
      cwd: "/repo",
    });
    await receipt.interrupt?.();
    const result = await receipt.completion;
    expect(result?.error).toStartWith(CODEX_CAPACITY_ERROR);
    expect(turnStarts(fake)).toHaveLength(2);
    expect(
      fake.requests.find((request) => request.method === "turn/interrupt")
        ?.params,
    ).toMatchObject({ turnId: "failed-turn-1" });
  });

  test("does not retry failures that are not capacity errors", async () => {
    const fake = new FakeCodexTransport();
    fake.failNextTurns = 1;
    fake.failure = { message: "model refused", codexErrorInfo: "other" };
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    expect(await handle.completion).toMatchObject({
      success: false,
      error: "model refused",
    });
    expect(turnStarts(fake)).toHaveLength(1);
  });

  test("includes Codex error notifications in the failed turn's error", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    fake.errorNotification({ message: "Reconnecting... 1/5" }, "turn-1", true);
    fake.errorNotification({
      message: "stream disconnected before completion",
    });
    fake.fail("turn-1", null);
    expect(await handle.completion).toMatchObject({
      success: false,
      error: "stream disconnected before completion",
    });
  });

  test("does not repeat an error notification that matches the turn error", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    fake.errorNotification({ message: "quota exceeded" });
    fake.errorNotification({ message: "context window exceeded" });
    fake.fail("turn-1", { message: "quota exceeded" });
    expect(await handle.completion).toMatchObject({
      error: "quota exceeded; context window exceeded",
    });
  });

  test("treats a 409 reported only through an error notification as a capacity failure", async () => {
    const fake = new FakeCodexTransport();
    const handle = await startCodexTurn(
      { prompt: "Implement it", parentAgentId: "parent", cwd: "/repo" },
      { createTransport: () => fake.transport(), sleep: async () => {} },
    );
    fake.item("item/started", {
      type: "fileChange",
      id: "patch-1",
      changes: [{ path: "src/a.ts" }],
    });
    fake.errorNotification({ message: CAPACITY_MESSAGE });
    fake.fail("turn-1", null);
    const result = await handle.completion;
    expect(result.error).toStartWith(CODEX_CAPACITY_ERROR);
    expect(result.error).toContain("409 Conflict");
  });
});

describe("Codex model discovery", () => {
  test("reports a missing codex executable instead of a stdin EPIPE", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "letta-codex-missing-"));
    try {
      await expect(
        listCodexModels(process.cwd(), { PATH: emptyPath, Path: emptyPath }),
      ).rejects.toThrow("Required executable 'codex' was not found on PATH");
    } finally {
      rmSync(emptyPath, { force: true, recursive: true });
    }
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
