import { afterEach, describe, expect, test } from "bun:test";
import {
  ABORT_GRACE_MS,
  type ApprovalResult,
  appendAbortPartials,
  buildCompanionResults,
  buildDeniedResults,
  executeApprovalBatch,
  overlayPartialResults,
  settleApprovalExecutionTasks,
} from "@/agent/approval-execution";
import {
  clearAllSubagents,
  clearSubagentAbortHook,
  getSubagents,
  interruptActiveSubagents,
  registerSubagent,
  registerSubagentAbortHook,
} from "@/agent/subagent-state";
import { INTERRUPTED_BY_USER } from "@/constants";

/**
 * Tests for aborting in-flight tool executions (the "cancel waits for the
 * slowest signal-ignoring tool" bug). settleApprovalExecutionTasks must race
 * batch settlement against the abort signal so a cancel unwinds the batch
 * without waiting for stragglers, while preserving completed partial results.
 */

const neverSettles = () => new Promise<void>(() => {});

const result = (toolCallId: string): ApprovalResult => ({
  type: "tool",
  tool_call_id: toolCallId,
  status: "success",
  tool_return: `${toolCallId}-done`,
});

describe("settleApprovalExecutionTasks abort race", () => {
  test("abort unwinds the batch without waiting for a hanging task", async () => {
    const controller = new AbortController();
    const settled: PromiseSettledResult<void>[] = [];
    const settle = settleApprovalExecutionTasks(
      [neverSettles(), neverSettles()],
      () => [result("call-a")],
      { abortSignal: controller.signal },
    ).then(
      (value) => {
        settled.push({ status: "fulfilled", value });
      },
      (reason) => {
        settled.push({ status: "rejected", reason });
      },
    );

    await Bun.sleep(5);
    expect(settled).toEqual([]); // still waiting on the hanging tasks
    controller.abort();
    await settle;

    const outcome = settled[0];
    expect(settled.length).toBe(1);
    if (!outcome || outcome.status !== "rejected") {
      throw new Error("expected the batch to reject");
    }
    const error = outcome.reason as Error & {
      partialResults?: ApprovalResult[];
    };
    expect(error.name).toBe("AbortError");
    expect(error.partialResults).toEqual([result("call-a")]);
  });

  test("prefers a settled rejection over the synthesized abort error", async () => {
    const controller = new AbortController();
    const rejection = new Error("tool failed") as Error & {
      partialResults?: ApprovalResult[];
    };
    const task = Promise.reject(rejection);
    const promise = settleApprovalExecutionTasks(
      [task, neverSettles()],
      () => [],
      { abortSignal: controller.signal },
    );
    await Bun.sleep(5);
    controller.abort();

    await expect(promise).rejects.toThrow("tool failed");
    expect(rejection.partialResults).toEqual([]);
  });

  test("synthesizes INTERRUPTED_BY_USER when abort reason is not an Error", async () => {
    const controller = new AbortController();
    const promise = settleApprovalExecutionTasks([neverSettles()], () => [], {
      abortSignal: controller.signal,
    });
    await Bun.sleep(5);
    controller.abort("custom-reason");

    await expect(promise).rejects.toThrow(INTERRUPTED_BY_USER);
  });

  test("resolves normally when every task fulfills before the abort", async () => {
    const controller = new AbortController();
    const promise = settleApprovalExecutionTasks(
      [Promise.resolve(), Promise.resolve()],
      () => [],
      { abortSignal: controller.signal },
    );
    await promise;
    controller.abort(); // late abort must not resurrect a settled batch
    await Bun.sleep(5);
  });

  test("still throws the first rejection when no signal is provided", async () => {
    const first = new Error("first failure") as Error & {
      partialResults?: ApprovalResult[];
    };
    const promise = settleApprovalExecutionTasks(
      [Promise.reject(first), Promise.resolve()],
      () => [result("call-a")],
    );
    await expect(promise).rejects.toThrow("first failure");
    expect(first.partialResults).toEqual([result("call-a")]);
  });

  test("an already-aborted signal settles normally (freeze semantics)", async () => {
    const controller = new AbortController();
    controller.abort();
    // Executors return fulfilled interrupted results without running tools
    // when the signal is pre-aborted; the batch must not synthesize a throw.
    await settleApprovalExecutionTasks(
      [Promise.resolve(), Promise.resolve()],
      () => [],
      { abortSignal: controller.signal },
    );
  });

  test("executeApprovalBatch unwinds on abort with completed partial results", async () => {
    const controller = new AbortController();
    const decisions = [
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-a",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-b",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
    ];

    const promise = executeApprovalBatch(decisions, undefined, {
      abortSignal: controller.signal,
      toolContextId: "context-abort-race",
      executeTool: (async (
        _toolName: string,
        _args: Record<string, unknown>,
        opts: { toolCallId: string },
      ): Promise<{ toolReturn: string; status: "success" }> => {
        if (opts.toolCallId === "call-a") {
          return { toolReturn: "call-a-done", status: "success" };
        }
        await Bun.sleep(10_000); // call-b ignores the abort signal
        return { toolReturn: "call-b-done", status: "success" };
      }) as never,
    });

    await Bun.sleep(20);
    controller.abort();
    const error = (await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    )) as Error & { partialResults?: ApprovalResult[] };

    expect(error.name).toBe("AbortError");
    expect(error.partialResults).toEqual([result("call-a")]);
  });

  test("mid-batch abort resolves with real results when tools honor the signal in the grace window", async () => {
    const controller = new AbortController();
    const decisions = [
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-a",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-b",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
    ];

    const promise = executeApprovalBatch(decisions, undefined, {
      abortSignal: controller.signal,
      toolContextId: "context-abort-race",
      executeTool: (async (
        _toolName: string,
        _args: Record<string, unknown>,
        opts: { toolCallId: string; signal?: AbortSignal },
      ): Promise<{ toolReturn: string; status: "success" }> => {
        if (opts.toolCallId === "call-a") {
          return { toolReturn: "call-a-done", status: "success" };
        }
        // call-b honors the abort signal: settles shortly after the abort,
        // well inside the grace window.
        await Bun.sleep(30);
        if (opts.signal?.aborted) {
          return { toolReturn: "call-b-interrupted", status: "success" };
        }
        return { toolReturn: "call-b-done", status: "success" };
      }) as never,
    });

    await Bun.sleep(10);
    controller.abort();
    // The batch must RESOLVE with the real results (no throw): a cancel of
    // well-behaved tools is a cancel, not "This operation was aborted".
    const results = await promise;
    expect(results.map((r) => r.tool_call_id)).toEqual(["call-a", "call-b"]);
  });

  test("late onChunk from a discarded straggler is suppressed after the grace-expiry throw", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const decisions = [
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-a",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
      {
        type: "approve" as const,
        approval: {
          toolCallId: "call-b",
          toolName: "Read",
          toolArgs: "{}",
        },
      },
    ];

    const promise = executeApprovalBatch(
      decisions,
      (chunk) => {
        chunks.push(chunk.tool_call_id);
      },
      {
        abortSignal: controller.signal,
        toolContextId: "context-abort-race",
        executeTool: (async (
          _toolName: string,
          _args: Record<string, unknown>,
          opts: { toolCallId: string },
        ): Promise<{ toolReturn: string; status: "success" }> => {
          if (opts.toolCallId === "call-a") {
            return { toolReturn: "call-a-done", status: "success" };
          }
          // call-b ignores the signal and returns after the grace expiry;
          // its late result is discarded and must not publish onChunk.
          await Bun.sleep(ABORT_GRACE_MS + 150);
          return { toolReturn: "call-b-done", status: "success" };
        }) as never,
      },
    );

    await Bun.sleep(10);
    controller.abort();
    const error = (await promise.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    )) as Error & { partialResults?: ApprovalResult[] };
    expect(error.name).toBe("AbortError");
    expect(error.partialResults).toEqual([result("call-a")]);

    // Let the straggler settle late; its onChunk must stay suppressed.
    await Bun.sleep(250);
    expect(chunks).toEqual(["call-a"]);
  });
});

describe("subagent abort hooks", () => {
  afterEach(() => {
    clearAllSubagents();
  });

  test("interruptActiveSubagents invokes the registered hook", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-abort-1",
      "general-purpose",
      "hook test",
      undefined,
      false,
      true,
    );
    registerSubagentAbortHook("sub-abort-1", () => {
      aborted.push("sub-abort-1");
    });

    interruptActiveSubagents(INTERRUPTED_BY_USER);

    expect(aborted).toEqual(["sub-abort-1"]);
  });

  test("cleared hooks are not invoked", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-abort-2",
      "general-purpose",
      "hook test",
      undefined,
      false,
      true,
    );
    registerSubagentAbortHook("sub-abort-2", () => {
      aborted.push("sub-abort-2");
    });
    clearSubagentAbortHook("sub-abort-2");

    interruptActiveSubagents(INTERRUPTED_BY_USER);

    expect(aborted).toEqual([]);
  });

  test("scoped interrupt only stops subagents in that conversation", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-scope-conv1",
      "general-purpose",
      "scoped",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: "conv-1" },
    );
    registerSubagent(
      "sub-scope-conv2",
      "general-purpose",
      "scoped",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: "conv-2" },
    );
    registerSubagentAbortHook("sub-scope-conv1", () => {
      aborted.push("sub-scope-conv1");
    });
    registerSubagentAbortHook("sub-scope-conv2", () => {
      aborted.push("sub-scope-conv2");
    });

    interruptActiveSubagents(INTERRUPTED_BY_USER, {
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(aborted).toEqual(["sub-scope-conv1"]);
    const other = getSubagents().find((a) => a.id === "sub-scope-conv2");
    expect(other?.status).toBe("pending"); // concurrent conversation untouched
  });

  test("subagents with no recorded conversation stay interruptible by agent", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-scope-noscope",
      "general-purpose",
      "no conversation",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: null },
    );
    registerSubagentAbortHook("sub-scope-noscope", () => {
      aborted.push("sub-scope-noscope");
    });

    interruptActiveSubagents(INTERRUPTED_BY_USER, {
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(aborted).toEqual(["sub-scope-noscope"]);
  });

  test("scoped interrupt skips subagents of other agents", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-scope-other-agent",
      "general-purpose",
      "other agent",
      undefined,
      false,
      true,
      { agentId: "agent-2", conversationId: "conv-1" },
    );
    registerSubagentAbortHook("sub-scope-other-agent", () => {
      aborted.push("sub-scope-other-agent");
    });

    interruptActiveSubagents(INTERRUPTED_BY_USER, {
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(aborted).toEqual([]);
  });

  test("default-conversation interrupt does not hit explicit-conversation subagents", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-default-parent",
      "general-purpose",
      "default parent",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: "default" },
    );
    registerSubagent(
      "sub-explicit-parent",
      "general-purpose",
      "explicit parent",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: "conv-1" },
    );
    registerSubagentAbortHook("sub-default-parent", () => {
      aborted.push("sub-default-parent");
    });
    registerSubagentAbortHook("sub-explicit-parent", () => {
      aborted.push("sub-explicit-parent");
    });

    // Esc in the default conversation must scope to default-parented tasks,
    // not act as an agent-wide wildcard over explicit conversations.
    interruptActiveSubagents(INTERRUPTED_BY_USER, {
      agentId: "agent-1",
      conversationId: "default",
    });

    expect(aborted).toEqual(["sub-default-parent"]);
  });

  test("default-conversation interrupt still reaches legacy unscoped subagents", () => {
    const aborted: string[] = [];
    registerSubagent(
      "sub-default-legacy",
      "general-purpose",
      "legacy unscoped",
      undefined,
      false,
      true,
      { agentId: "agent-1", conversationId: null },
    );
    registerSubagentAbortHook("sub-default-legacy", () => {
      aborted.push("sub-default-legacy");
    });

    interruptActiveSubagents(INTERRUPTED_BY_USER, {
      agentId: "agent-1",
      conversationId: "default",
    });

    expect(aborted).toEqual(["sub-default-legacy"]);
  });
});

describe("overlayPartialResults", () => {
  const synthetic = (toolCallId: string): ApprovalResult => ({
    type: "tool",
    tool_call_id: toolCallId,
    tool_return: INTERRUPTED_BY_USER,
    status: "error",
  });

  test("real partials replace synthetic interrupted results for the same tool", () => {
    const queued = [synthetic("t1"), synthetic("t2")];
    const overlaid = overlayPartialResults(queued, [result("t1")]);
    expect(overlaid).toEqual([result("t1"), synthetic("t2")]);
  });

  test("partials for tools missing from the queue are appended, not dropped", () => {
    const queued = [synthetic("t1")];
    const overlaid = overlayPartialResults(queued, [
      result("t1"),
      result("t-denied"),
    ]);
    expect(overlaid).toEqual([result("t1"), result("t-denied")]);
  });

  test("partials alone still surface when nothing was queued", () => {
    const overlaid = overlayPartialResults(null, [result("t1")]);
    expect(overlaid).toEqual([result("t1")]);
  });
});

describe("companion and denial results", () => {
  const approval = (toolCallId: string) => ({
    toolCallId,
    toolName: "Read",
    toolArgs: "{}",
  });

  test("buildCompanionResults maps auto-handled tools and auto-denied calls", () => {
    const companions = buildCompanionResults(
      [
        {
          toolCallId: "t-handled",
          result: {
            toolReturn: "handled-done",
            status: "success",
            stdout: undefined,
            stderr: undefined,
          },
        },
      ],
      [{ approval: approval("t-denied"), reason: "not allowed" }],
    );
    expect(companions).toEqual([
      {
        type: "tool",
        tool_call_id: "t-handled",
        tool_return: "handled-done",
        status: "success",
        stdout: undefined,
        stderr: undefined,
      },
      {
        type: "approval",
        tool_call_id: "t-denied",
        approve: false,
        reason: "not allowed",
      },
    ]);
  });

  test("buildDeniedResults maps denial decisions to their wire form", () => {
    expect(
      buildDeniedResults([{ approval: approval("t-denied"), reason: "nope" }]),
    ).toEqual([
      {
        type: "approval",
        tool_call_id: "t-denied",
        approve: false,
        reason: "nope",
      },
    ]);
  });
});

describe("appendAbortPartials", () => {
  test("appends extras to an abort error's existing partials", () => {
    const error = new Error(INTERRUPTED_BY_USER) as Error & {
      partialResults?: ApprovalResult[];
    };
    error.partialResults = [result("t1")];
    appendAbortPartials(error, [
      {
        type: "approval",
        tool_call_id: "t-denied",
        approve: false,
        reason: "no",
      },
    ]);
    expect(error.partialResults).toEqual([
      result("t1"),
      {
        type: "approval",
        tool_call_id: "t-denied",
        approve: false,
        reason: "no",
      },
    ]);
  });

  test("creates partials when the abort error carries none", () => {
    const error = new Error(INTERRUPTED_BY_USER) as Error & {
      partialResults?: ApprovalResult[];
    };
    appendAbortPartials(error, [result("t1")]);
    expect(error.partialResults).toEqual([result("t1")]);
  });

  test("ignores non-abort errors and empty extras", () => {
    const plain = new Error("boom") as Error & {
      partialResults?: ApprovalResult[];
    };
    appendAbortPartials(plain, [result("t1")]);
    expect(plain.partialResults).toBeUndefined();

    const aborted = new Error(INTERRUPTED_BY_USER) as Error & {
      partialResults?: ApprovalResult[];
    };
    appendAbortPartials(aborted, []);
    expect(aborted.partialResults).toBeUndefined();
  });
});
