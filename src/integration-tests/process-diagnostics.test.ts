import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { summarizeWireFailures, withTestStage } from "./process-diagnostics";

describe("wire failure diagnostics", () => {
  test("retains an early error even when later successful output is noisy", () => {
    const messages = [
      {
        type: "error",
        stop_reason: "llm_api_error",
        api_error: { error_type: "llm_authentication", message: "private" },
      },
      { type: "result", subtype: "error", stop_reason: "llm_api_error" },
      ...Array.from({ length: 20 }, () => ({
        type: "result",
        subtype: "success",
      })),
    ];
    const summary = JSON.parse(summarizeWireFailures(messages));
    expect(summary.failureCount).toBe(2);
    expect(summary.recentFailures[0].apiErrorType).toBe("llm_authentication");
    expect(summary.recentFailures[1].stopReason).toBe("llm_api_error");
  });

  test("omits free text, identifiers, and unrecognized category values", () => {
    const sensitive = "SYNTHETIC_PRIVATE_VALUE";
    const summary = summarizeWireFailures([
      { type: "message", content: sensitive },
      {
        type: "error",
        subtype: sensitive,
        stop_reason: sensitive,
        message: sensitive,
        run_id: sensitive,
        api_error: {
          error_type: sensitive,
          message: sensitive,
          detail: sensitive,
        },
      },
      {
        type: "result",
        subtype: "error",
        stop_reason: "error",
        result: sensitive,
        agent_id: sensitive,
        conversation_id: sensitive,
      },
    ]);
    expect(summary).not.toContain(sensitive);
    expect(summary).toContain("unknown_or_omitted");
    expect(JSON.parse(summary).failureCount).toBe(2);
  });

  test("bounds repeated failures while retaining their total count", () => {
    const summary = summarizeWireFailures(
      Array.from({ length: 100 }, () => ({
        type: "error",
        stop_reason: "error",
        message: "x".repeat(10000),
      })),
    );
    const parsed = JSON.parse(summary);
    expect(parsed.failureCount).toBe(100);
    expect(parsed.recentFailures).toHaveLength(5);
    expect(summary.length).toBeLessThan(1000);
  });

  test("preserves interrupted results and tolerates missing API metadata", () => {
    const summary = JSON.parse(
      summarizeWireFailures([
        { type: "result", subtype: "interrupted", stop_reason: "cancelled" },
        { type: "error", api_error: null },
      ]),
    );
    expect(summary.recentFailures[0].subtype).toBe("interrupted");
    expect(summary.recentFailures[0].stopReason).toBe("cancelled");
    expect(summary.recentFailures[1].apiErrorType).toBe("unknown_or_omitted");
  });

  test("a successful stream has no reported failure", () => {
    expect(
      JSON.parse(
        summarizeWireFailures([{ type: "result", subtype: "success" }]),
      ),
    ).toEqual({ failureCount: 0, recentFailures: [] });
  });
});

describe("test-stage diagnostics", () => {
  let log: ReturnType<typeof spyOn> | undefined;
  afterEach(() => log?.mockRestore());

  test("prints the pending stage before work settles and preserves its result", async () => {
    log = spyOn(console, "info").mockImplementation(() => {});
    const deferred = Promise.withResolvers<object>();
    const result = { payload: "SYNTHETIC_PRIVATE_VALUE" };
    const pending = withTestStage("cli.set-reasoning", () => deferred.promise);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[api-test] cli.set-reasoning start");
    deferred.resolve(result);
    expect(await pending).toBe(result);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toMatch(
      /cli\.set-reasoning completed elapsed_ms=\d+/,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(result.payload);
  });

  test("reports failure without swallowing or logging the thrown error", async () => {
    log = spyOn(console, "info").mockImplementation(() => {});
    const error = new Error("SYNTHETIC_PRIVATE_VALUE");
    await expect(
      withTestStage("conversation.create", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toMatch(
      /conversation\.create failed elapsed_ms=\d+/,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  });
});
