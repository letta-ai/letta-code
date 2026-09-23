import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  addToolCall,
  clearAllSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  getSubagentToolCount,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import type { Line } from "@/cli/helpers/accumulator";
import { createBuffers, onChunk } from "@/cli/helpers/accumulator";
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

describe("cloud tool return clamping", () => {
  test("caps oversized server-side tool returns stored in lines", () => {
    const buffers = createBuffers("agent-test");
    onChunk(buffers, {
      message_type: "tool_call_message",
      id: "msg-1",
      tool_call: {
        tool_call_id: "tc-big",
        name: "web_search",
        arguments: "{}",
      },
    } as LettaStreamingResponse);

    const big = "z".repeat(LIMITS.TOOL_RETURN_MAX_CHARS * 3);
    onChunk(buffers, {
      message_type: "tool_return_message",
      id: "msg-2",
      tool_call_id: "tc-big",
      status: "success",
      tool_return: big,
    } as LettaStreamingResponse);

    const line = buffers.byId.get("tc-big");
    if (!line || line.kind !== "tool_call") {
      throw new Error("expected finished tool call line");
    }
    const resultText = line.resultText ?? "";
    expect(line.phase).toBe("finished");
    expect(line.resultOk).toBe(true);
    expect(resultText).not.toBe(big);
    expect(resultText.length).toBeLessThan(
      LIMITS.TOOL_RETURN_MAX_CHARS + 1_000,
    );
    expect(resultText).toContain("[Output truncated: showing");

    const match = resultText.match(/Full output written to: (.+\.txt)/);
    if (match?.[1] && fs.existsSync(match[1])) {
      fs.unlinkSync(match[1]);
    }
  });

  test("leaves small tool returns untouched", () => {
    const buffers = createBuffers("agent-test");
    onChunk(buffers, {
      message_type: "tool_call_message",
      id: "msg-1",
      tool_call: {
        tool_call_id: "tc-small",
        name: "web_search",
        arguments: "{}",
      },
    } as LettaStreamingResponse);
    onChunk(buffers, {
      message_type: "tool_return_message",
      id: "msg-2",
      tool_call_id: "tc-small",
      status: "success",
      tool_return: "short result",
    } as LettaStreamingResponse);

    const line = buffers.byId.get("tc-small");
    if (!line || line.kind !== "tool_call") {
      throw new Error("expected finished tool call line");
    }
    expect(line.resultText).toBe("short result");
  });
});
