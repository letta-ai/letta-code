import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  addToolCall,
  clearAllSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  getSubagentToolCount,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { createBuffers, type Line, onChunk } from "@/cli/helpers/accumulator";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
} from "@/cli/helpers/subagent-aggregation";
import { LIMITS } from "@/tools/impl/truncation";

describe("subagent tool count stability", () => {
  beforeEach(() => {
    clearAllSubagents();
  });

  test("tool count remains monotonic even if toolCalls array is overwritten with fewer entries", () => {
    registerSubagent(
      "sub-1",
      "general-purpose",
      "Find symbols",
      "tc-task",
      false,
    );
    addToolCall("sub-1", "tc-read", "Read", "{}");
    addToolCall("sub-1", "tc-grep", "Grep", "{}");

    const before = getSubagentByToolCallId("tc-task");
    if (!before) {
      throw new Error("Expected subagent for tc-task");
    }
    expect(getSubagentToolCount(before)).toBe(2);

    // Simulate a stale overwrite (should not reduce displayed count).
    updateSubagent("sub-1", {
      toolCalls: before.toolCalls.slice(0, 1),
    });

    const after = getSubagentByToolCallId("tc-task");
    if (!after) {
      throw new Error("Expected updated subagent for tc-task");
    }
    expect(after.toolCalls.length).toBe(1);
    expect(getSubagentToolCount(after)).toBe(2);

    completeSubagent("sub-1", { success: true });
    const completed = getSubagentByToolCallId("tc-task");
    if (!completed) {
      throw new Error("Expected completed subagent for tc-task");
    }
    expect(getSubagentToolCount(completed)).toBe(2);
  });

  test("static subagent grouping uses monotonic tool count", () => {
    registerSubagent(
      "sub-1",
      "general-purpose",
      "Find symbols",
      "tc-task",
      false,
    );
    addToolCall("sub-1", "tc-read", "Read", "{}");
    addToolCall("sub-1", "tc-grep", "Grep", "{}");
    completeSubagent("sub-1", { success: true, totalTokens: 42 });

    const subagent = getSubagentByToolCallId("tc-task");
    if (!subagent) {
      throw new Error("Expected subagent for tc-task before grouping");
    }

    // Simulate stale reduction right before grouping.
    updateSubagent("sub-1", {
      toolCalls: subagent.toolCalls.slice(0, 1),
    });

    const order = ["line-task"];
    const byId = new Map<string, Line>([
      [
        "line-task",
        {
          kind: "tool_call",
          id: "line-task",
          name: "Task",
          phase: "finished",
          toolCallId: "tc-task",
          resultOk: true,
        },
      ],
    ]);

    const finished = collectFinishedTaskToolCalls(
      order,
      byId,
      new Set<string>(),
      false,
    );
    expect(finished.length).toBe(1);

    const group = createSubagentGroupItem(finished);
    expect(group.agents.length).toBe(1);
    expect(group.agents[0]?.toolCount).toBe(2);
  });
});

describe("cloud tool return clipping", () => {
  function sendToolCallAndReturn(
    buffers: ReturnType<typeof createBuffers>,
    toolReturn: string,
  ): Line {
    onChunk(buffers, {
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "cloud-call",
        name: "web_search",
        arguments: "{}",
      },
    } as never);

    onChunk(buffers, {
      message_type: "tool_return_message",
      tool_call_id: "cloud-call",
      status: "success",
      tool_return: toolReturn,
    } as never);

    const line = buffers.byId.get("cloud-call");
    if (!line || line.kind !== "tool_call") {
      throw new Error("expected a tool_call line for cloud-call");
    }
    return line;
  }

  test("retains small tool returns unchanged", () => {
    const line = sendToolCallAndReturn(createBuffers(), "small result");
    expect(line.kind === "tool_call" && line.resultText).toBe("small result");
    expect(line.kind === "tool_call" && line.phase).toBe("finished");
  });

  test("clips oversized server-side tool returns to the shared backstop limit", () => {
    const big = `HEAD-${"a".repeat(LIMITS.TOOL_RETURN_MAX_CHARS + 50_000)}-TAIL`;
    const line = sendToolCallAndReturn(createBuffers(), big);

    const resultText = line.kind === "tool_call" ? line.resultText : undefined;
    if (resultText === undefined) throw new Error("expected resultText");

    expect(resultText.length).toBeLessThan(
      LIMITS.TOOL_RETURN_MAX_CHARS + 1_000,
    );
    expect(resultText).toContain("[Output truncated: showing");
    // Middle truncation keeps both ends available for display and ctrl+o.
    expect(resultText.startsWith("HEAD-")).toBe(true);
    expect(resultText).toContain("-TAIL");

    // The full output lands in an overflow file; verify, then clean it up.
    const match = resultText.match(/Full output written to: (.+\.txt)/);
    expect(match).toBeDefined();
    if (match?.[1]) {
      expect(fs.existsSync(match[1])).toBe(true);
      expect(fs.readFileSync(match[1], "utf-8").length).toBe(big.length);
      fs.unlinkSync(match[1]);
    }
  });

  test("passes through output already clamped by a per-tool 30K limit", () => {
    // Local tool returns arrive pre-clamped (30K + notice) and must not be
    // re-truncated on the way into the transcript.
    const alreadyClamped = `${"b".repeat(30_000)}\n\n[Output truncated: showing 30,000 of 100,000 characters.]`;
    const line = sendToolCallAndReturn(createBuffers(), alreadyClamped);
    expect(line.kind === "tool_call" && line.resultText).toBe(alreadyClamped);
  });
});

describe("assistant text after interleaved reasoning", () => {
  test("streams the rest of the reply into a continuation line instead of a finished row", () => {
    const b = createBuffers();
    b.tokenStreamingEnabled = true;
    const assistant = (text: string) =>
      onChunk(b, {
        message_type: "assistant_message",
        otid: "assistant-otid",
        id: "msg-1",
        content: [{ type: "text", text }],
      } as unknown as Parameters<typeof onChunk>[1]);

    assistant("Короткий ответ: нет. Я све");
    onChunk(b, {
      message_type: "reasoning_message",
      otid: "reasoning-otid",
      id: "msg-1:reasoning:0",
      reasoning: " ",
    } as unknown as Parameters<typeof onChunk>[1]);
    assistant("рил исходники.");

    const head = b.byId.get("msg-1");
    expect(head?.kind === "assistant" && head.phase).toBe("finished");
    expect(head?.kind === "assistant" && head.text).toBe(
      "Короткий ответ: нет. Я све",
    );

    const continuation = b.byId.get("msg-1-cont-0");
    expect(continuation?.kind).toBe("assistant");
    expect(continuation?.kind === "assistant" && continuation.text).toBe(
      "рил исходники.",
    );
    expect(continuation?.kind === "assistant" && continuation.phase).toBe(
      "streaming",
    );
    expect(b.order.at(-1)).toBe("msg-1-cont-0");
  });
});
