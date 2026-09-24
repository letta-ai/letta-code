import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  createBuffers,
  markIncompleteToolsAsCancelled,
  onChunk,
} from "@/cli/helpers/accumulator";
import { drainStream } from "@/cli/helpers/stream";
import { hasInProgressTaskToolCalls } from "@/cli/helpers/subagent-aggregation";
import {
  evictCommittedLines,
  findFirstUserLineTitle,
  findLastShellToolCallId,
  isEvictedToolCallChunk,
  MAX_EVICTED_TOOL_CALL_IDS,
  MAX_LINE_ALIAS_ENTRIES,
  MAX_UNIFIED_EXEC_SESSION_COMMANDS,
  prepareBuffersForTurn,
} from "@/cli/helpers/transcript-eviction";

function addUserLine(buffers: ReturnType<typeof createBuffers>): void {
  buffers.byId.set("user-1", {
    kind: "user",
    id: "user-1",
    text: "hello",
    otid: "otid-u1",
  });
  buffers.userLineIdByOtid.set("otid-u1", "user-1");
  buffers.order.push("user-1");
}

function addFinishedToolCall(
  buffers: ReturnType<typeof createBuffers>,
  toolCallId: string,
  name = "Bash",
): void {
  onChunk(buffers, {
    message_type: "approval_request_message",
    tool_call: {
      tool_call_id: toolCallId,
      name,
      arguments: JSON.stringify({ cmd: "echo hi" }),
    },
  } as never);
  onChunk(buffers, {
    message_type: "tool_return_message",
    tool_call_id: toolCallId,
    status: "success",
    tool_return: "ok",
  } as never);
}

describe("evictCommittedLines", () => {
  test("evicts committed lines and keeps uncommitted lines", () => {
    const buffers = createBuffers();
    addUserLine(buffers);
    addFinishedToolCall(buffers, "tc-1");
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-a1",
      content: "still streaming",
    } as never);

    const evicted = evictCommittedLines(buffers, new Set(["user-1", "tc-1"]));

    expect(evicted).toBe(2);
    expect(buffers.byId.has("user-1")).toBe(false);
    expect(buffers.byId.has("tc-1")).toBe(false);
    expect(buffers.order).toEqual(["msg-1"]);
    expect(buffers.byId.get("msg-1")?.kind).toBe("assistant");
  });

  test("prunes per-line mappings for evicted tool calls and user lines", () => {
    const buffers = createBuffers();
    addUserLine(buffers);
    addFinishedToolCall(buffers, "tc-1");
    // Leftover server-tool entry (interrupted server tools leaked these before)
    buffers.serverToolCalls.set("tc-1", {
      toolName: "Bash",
      toolArgs: "{}",
      preToolUseTriggered: true,
    });
    buffers.splitCounters.set("tc-1", 2);
    expect(buffers.toolCallIdToLineId.has("tc-1")).toBe(true);

    evictCommittedLines(buffers, new Set(["user-1", "tc-1"]));

    expect(buffers.toolCallIdToLineId.has("tc-1")).toBe(false);
    expect(buffers.serverToolCalls.has("tc-1")).toBe(false);
    expect(buffers.splitCounters.has("tc-1")).toBe(false);
    expect(buffers.userLineIdByOtid.has("otid-u1")).toBe(false);
  });

  test("only prunes userLineIdByOtid when it still maps to the evicted line", () => {
    const buffers = createBuffers();
    addUserLine(buffers);
    buffers.userLineIdByOtid.set("otid-u1", "user-2");

    evictCommittedLines(buffers, new Set(["user-1"]));

    expect(buffers.userLineIdByOtid.get("otid-u1")).toBe("user-2");
  });

  test("drops a late tool_return for an evicted tool call", () => {
    const buffers = createBuffers();
    addFinishedToolCall(buffers, "tc-1");
    evictCommittedLines(buffers, new Set(["tc-1"]));

    onChunk(buffers, {
      message_type: "tool_return_message",
      tool_call_id: "tc-1",
      status: "success",
      tool_return: "late duplicate",
    } as never);

    // No zombie line is re-created; the committed static copy stays canonical.
    expect(buffers.byId.has("tc-1")).toBe(false);
    expect(buffers.order).toEqual([]);
  });

  test("re-evicts a line re-created under a committed id after stream resume", () => {
    const buffers = createBuffers();
    addFinishedToolCall(buffers, "tc-1");
    const committed = new Set(["tc-1"]);
    evictCommittedLines(buffers, committed);

    // A resumed stream can re-send the tool call; with the mapping pruned
    // this re-creates a line under the same (still committed) id.
    onChunk(buffers, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "tc-1",
        name: "Bash",
        arguments: JSON.stringify({ cmd: "echo hi" }),
      },
    } as never);
    expect(buffers.byId.has("tc-1")).toBe(true);

    // The next turn-boundary pass removes it again.
    expect(evictCommittedLines(buffers, committed)).toBe(1);
    expect(buffers.byId.has("tc-1")).toBe(false);
    expect(buffers.order).toEqual([]);
  });

  test("trims the secondary maps to their caps", () => {
    const buffers = createBuffers();
    for (let i = 0; i < MAX_LINE_ALIAS_ENTRIES + 10; i++) {
      buffers.assistantCanonicalByMessageId.set(`m-${i}`, `line-${i}`);
    }
    for (let i = 0; i < MAX_UNIFIED_EXEC_SESSION_COMMANDS + 5; i++) {
      buffers.unifiedExecSessionCommands.set(`s-${i}`, `cmd-${i}`);
    }

    evictCommittedLines(buffers, new Set());

    expect(buffers.assistantCanonicalByMessageId.size).toBe(
      MAX_LINE_ALIAS_ENTRIES,
    );
    // Oldest-inserted entries are dropped first.
    expect(buffers.assistantCanonicalByMessageId.has("m-0")).toBe(false);
    expect(
      buffers.assistantCanonicalByMessageId.has(
        `m-${MAX_LINE_ALIAS_ENTRIES + 9}`,
      ),
    ).toBe(true);
    expect(buffers.unifiedExecSessionCommands.size).toBe(
      MAX_UNIFIED_EXEC_SESSION_COMMANDS,
    );
    expect(buffers.unifiedExecSessionCommands.has("s-0")).toBe(false);
  });

  test("keeps id/otid aliases so multi-block assistant streams keep working", () => {
    const buffers = createBuffers();
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-a",
      content: "First block.",
    } as never);
    // Transition to a reasoning block finishes the first assistant block.
    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "msg-r",
      otid: "otid-r",
      reasoning: "thinking",
    } as never);
    // A second text block for the same message (Anthropic text/thinking/text)
    // opens a fresh line while the first block is still in the buffers.
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-c",
      content: "Second block.",
    } as never);

    expect(buffers.byId.get("msg-1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "First block.",
    });
    expect(buffers.byId.get("otid-c")).toMatchObject({
      kind: "assistant",
      text: "Second block.",
    });

    // Evicting the finished lines must not prune the alias maps the
    // resolvers depend on for mixed id/otid streams.
    evictCommittedLines(buffers, new Set(["msg-1", "msg-r"]));
    expect(buffers.byId.has("msg-1")).toBe(false);
    expect(buffers.byId.has("msg-r")).toBe(false);
    // The message id alias follows the message's latest block line, and the
    // first block's otid alias is retained for mixed id/otid resolution.
    expect(buffers.assistantCanonicalByMessageId.get("msg-1")).toBe("otid-c");
    expect(buffers.assistantCanonicalByOtid.get("otid-a")).toBe("msg-1");
    expect(buffers.order).toEqual(["otid-c"]);
  });
});

describe("prepareBuffersForTurn", () => {
  test("evicts committed lines and resets per-turn buffer state", () => {
    const buffers = createBuffers();
    addUserLine(buffers);
    buffers.tokenCount = 123;
    buffers.interrupted = true;

    prepareBuffersForTurn(buffers, new Set(["user-1"]));

    expect(buffers.byId.has("user-1")).toBe(false);
    expect(buffers.order).toEqual([]);
    expect(buffers.tokenCount).toBe(0);
    expect(buffers.interrupted).toBe(false);
  });
});

describe("replayed tool chunks for evicted lines", () => {
  const serverToolCall = {
    message_type: "tool_call_message",
    tool_call: {
      tool_call_id: "tc-server",
      name: "Bash",
      arguments: JSON.stringify({ command: "sleep 30" }),
    },
  } as LettaStreamingResponse;
  const taskApproval = {
    message_type: "approval_request_message",
    tool_call: {
      tool_call_id: "tc-task",
      name: "Task",
      arguments: JSON.stringify({ prompt: "explore" }),
    },
  } as LettaStreamingResponse;

  function replayStream(
    chunks: LettaStreamingResponse[],
  ): Stream<LettaStreamingResponse> {
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }

  test("a 409 resume replay does not re-create evicted server tool or Task lines", async () => {
    const buffers = createBuffers("agent-test");
    addFinishedToolCall(buffers, "tc-task", "Task");
    onChunk(buffers, serverToolCall);
    // ESC while the server tool runs: its line finishes as interrupted.
    markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
    expect(buffers.serverToolCalls.get("tc-server")?.preToolUseTriggered).toBe(
      true,
    );

    // Next submit evicts both committed lines.
    prepareBuffersForTurn(buffers, new Set(["tc-task", "tc-server"]));

    // POST 409 conversation busy: the TUI resumes the still-active previous
    // run from the start (starting_after: 0) through drainStream.
    await drainStream(
      replayStream([
        serverToolCall,
        taskApproval,
        {
          message_type: "stop_reason",
          stop_reason: "requires_approval",
        } as LettaStreamingResponse,
      ]),
      buffers,
      () => {},
    );

    expect(buffers.order).toEqual([]);
    expect(buffers.byId.size).toBe(0);
    // PreToolUse runs when this entry is (re)created; it must not come back.
    expect(buffers.serverToolCalls.has("tc-server")).toBe(false);
    expect(
      hasInProgressTaskToolCalls(buffers.order, buffers.byId, new Set()),
    ).toBe(false);
    // ESC now still shows "Interrupted" (no zombie tool to cancel).
    expect(
      markIncompleteToolsAsCancelled(buffers, true, "user_interrupt"),
    ).toBe(false);
  });

  test("remembers a bounded number of evicted tool-call ids", () => {
    const buffers = createBuffers();
    const committed = new Set<string>();
    for (let i = 0; i <= MAX_EVICTED_TOOL_CALL_IDS; i++) {
      const id = `tc-${i}`;
      buffers.byId.set(id, {
        kind: "tool_call",
        id,
        toolCallId: id,
        phase: "finished",
      });
      buffers.order.push(id);
      committed.add(id);
    }

    evictCommittedLines(buffers, committed);

    const replayOf = (toolCallId: string) =>
      ({
        message_type: "tool_call_message",
        tool_call: { tool_call_id: toolCallId, name: "Bash" },
      }) as LettaStreamingResponse;
    // Oldest-evicted ids are dropped first.
    expect(isEvictedToolCallChunk(buffers, replayOf("tc-0"))).toBe(false);
    expect(
      isEvictedToolCallChunk(
        buffers,
        replayOf(`tc-${MAX_EVICTED_TOOL_CALL_IDS}`),
      ),
    ).toBe(true);
  });
});

describe("findLastShellToolCallId", () => {
  const committedShellCall = {
    kind: "tool_call" as const,
    id: "tc-old",
    phase: "finished" as const,
    resultText: "old output",
    name: "Bash",
  };

  test("returns null when there is no finished shell tool call", () => {
    const buffers = createBuffers();
    expect(findLastShellToolCallId(buffers, [])).toBeNull();
    expect(
      findLastShellToolCallId(buffers, [
        { kind: "tool_call", id: "tc-x", phase: "finished", name: "Read" },
      ]),
    ).toBeNull();
  });

  test("falls back to committed items once live buffers are evicted", () => {
    const buffers = createBuffers();
    expect(findLastShellToolCallId(buffers, [committedShellCall])).toBe(
      "tc-old",
    );
  });

  test("prefers a live finished shell call over older committed ones", () => {
    const buffers = createBuffers();
    addFinishedToolCall(buffers, "tc-new");
    expect(findLastShellToolCallId(buffers, [committedShellCall])).toBe(
      "tc-new",
    );

    // A live finished non-shell call does not shadow the shell call.
    addFinishedToolCall(buffers, "tc-read", "Read");
    expect(findLastShellToolCallId(buffers, [committedShellCall])).toBe(
      "tc-new",
    );
  });
});

describe("findFirstUserLineTitle", () => {
  test("returns the first user line's normalized title", () => {
    const buffers = createBuffers();
    expect(findFirstUserLineTitle(buffers)).toBeNull();

    buffers.byId.set("s-1", { kind: "status", id: "s-1", lines: ["boot"] });
    buffers.order.push("s-1");
    expect(findFirstUserLineTitle(buffers)).toBeNull();

    buffers.byId.set("u-1", {
      kind: "user",
      id: "u-1",
      text: "  hello\n   world  ",
    });
    buffers.order.push("u-1");
    expect(findFirstUserLineTitle(buffers)).toBe("hello world");
  });
});
