import { describe, expect, test } from "bun:test";
import {
  type ApprovalResult,
  executeApprovalBatch,
  settleApprovalExecutionTasks,
} from "@/agent/approval-execution";
import {
  clearSubagentAbortHook,
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
});

describe("subagent abort hooks", () => {
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
});
