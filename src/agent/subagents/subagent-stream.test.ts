import { describe, expect, test } from "bun:test";
import {
  type ExecutionState,
  looksLikeTruncatedStreamJson,
  parseResultFromStdout,
  processStreamEvent,
} from "./subagent-stream";

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  agent_id: "agent-1",
});
const resultLine = JSON.stringify({
  type: "result",
  result: "done",
  is_error: false,
});

describe("looksLikeTruncatedStreamJson", () => {
  test("detects a result envelope cut mid-line", () => {
    const truncated = `${initLine}\n${resultLine.slice(0, resultLine.length - 25)}`;
    expect(looksLikeTruncatedStreamJson(truncated)).toBe(true);
  });

  test("detects a partial line even when it is the only output", () => {
    expect(looksLikeTruncatedStreamJson('{"type":"result","resu')).toBe(true);
  });

  test("does not flag a complete stream ending in a result envelope", () => {
    expect(looksLikeTruncatedStreamJson(`${initLine}\n${resultLine}\n`)).toBe(
      false,
    );
  });

  test("does not flag complete-but-unexpected JSON output", () => {
    // Last line parses fine — this is a wrong-shape stream, not truncation,
    // so retrying could double side effects for no reason.
    expect(looksLikeTruncatedStreamJson(`${initLine}\n`)).toBe(false);
  });

  test("does not flag a complete non-JSON line", () => {
    // An invalid protocol line is not evidence of truncation when its line
    // terminator arrived. Retrying here could duplicate subagent side effects.
    expect(looksLikeTruncatedStreamJson(`${initLine}\nplain-text-log\n`)).toBe(
      false,
    );
  });

  test("does not flag empty output", () => {
    expect(looksLikeTruncatedStreamJson("")).toBe(false);
    expect(looksLikeTruncatedStreamJson("\n\n")).toBe(false);
  });

  test("handles CRLF line endings", () => {
    const truncated = `${initLine}\r\n${resultLine.slice(0, 10)}`;
    expect(looksLikeTruncatedStreamJson(truncated)).toBe(true);
    expect(
      looksLikeTruncatedStreamJson(`${initLine}\r\n${resultLine}\r\n`),
    ).toBe(false);
  });
});

function freshState(): ExecutionState {
  return {
    agentId: null,
    conversationId: null,
    finalResult: null,
    finalError: null,
    enqueueReceipt: null,
    resultStats: null,
    displayedToolCalls: new Set(),
  };
}

describe("result envelope parsing", () => {
  test("reads the error text of a Cloud-routed failure from `error`, not `result`", () => {
    // Cloud sends emit `{ result: null, error: "<text>" }`; reading `result`
    // turned every such failure into "Unknown error".
    const state = freshState();
    processStreamEvent(
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: null,
        error: "Listener connection closed; execution may still be running.",
      }),
      state,
      "sub-1",
    );
    expect(state.finalError).toBe(
      "Listener connection closed; execution may still be running.",
    );
    const parsed = parseResultFromStdout(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: null,
        error: "boom",
      }),
      "agent-1",
    );
    expect(parsed.error).toBe("boom");
  });

  test("keeps reading local failures from `result`", () => {
    const state = freshState();
    processStreamEvent(
      JSON.stringify({ type: "result", is_error: true, result: "local boom" }),
      state,
      "sub-1",
    );
    expect(state.finalError).toBe("local boom");
  });

  test("captures the enqueue receipt from a queued envelope", () => {
    const state = freshState();
    processStreamEvent(
      JSON.stringify({
        type: "result",
        subtype: "queued",
        is_error: false,
        result: null,
        status: "queued",
        agent_id: "agent-1",
        conversation_id: "conv-1",
        client_message_id: "cm-1",
        super_run_id: "sr-1",
        workflow_id: "wf-1",
        environment: { type: "computer", name: "office-mac" },
      }),
      state,
      "sub-1",
    );
    expect(state.enqueueReceipt).toEqual({
      status: "queued",
      agent_id: "agent-1",
      conversation_id: "conv-1",
      client_message_id: "cm-1",
      super_run_id: "sr-1",
      workflow_id: "wf-1",
    });
    expect(state.finalError).toBeNull();
    expect(state.finalResult).toBeNull();
  });

  test("a queued envelope missing receipt fields is an error, not a silent success", () => {
    const state = freshState();
    processStreamEvent(
      JSON.stringify({ type: "result", subtype: "queued", result: null }),
      state,
      "sub-1",
    );
    expect(state.enqueueReceipt).toBeNull();
    expect(state.finalError).toContain("without a complete receipt");
  });
});
