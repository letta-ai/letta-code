import { afterEach, describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  ReasoningMessage,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  clearAllSubagents,
  clearSubagentsByIds,
  completeSubagent,
  getSubagentByToolCallId,
  registerSubagent,
} from "@/agent/subagent-state";
import {
  createBuffers,
  type Line,
  markCurrentLineAsFinished,
  onChunk,
  toLines,
} from "@/cli/helpers/accumulator";
import {
  collectStaticTranscriptItems,
  selectLiveTranscriptItems,
  type TranscriptCommitState,
} from "./transcript-promotion";
import type { StaticItem } from "./types";

const date = "2026-01-01T00:00:00Z";

function assistant(content: string): AssistantMessage {
  return {
    message_type: "assistant_message",
    id: "assistant-message",
    otid: "assistant-otid",
    date,
    content,
  };
}

function reasoning(text: string): ReasoningMessage {
  return {
    message_type: "reasoning_message",
    id: "reasoning-message",
    otid: "reasoning-otid",
    date,
    reasoning: text,
  };
}

function textOf(items: StaticItem[], kind: "assistant" | "reasoning") {
  return items
    .filter((item) => item.kind === kind)
    .map((item) => ("text" in item ? item.text : ""))
    .join("");
}

function createTranscript(tokenStreamingEnabled = true) {
  const buffers = createBuffers();
  buffers.tokenStreamingEnabled = tokenStreamingEnabled;
  const state: TranscriptCommitState = {
    emittedIds: new Set(),
    deferredCommits: new Map(),
    eagerCommittedPreviews: new Set(),
  };
  const staticItems: StaticItem[] = [];
  const live = () =>
    selectLiveTranscriptItems(toLines(buffers), state.emittedIds, {
      tokenStreamingEnabled,
      showCompactionsEnabled: true,
    });
  return {
    buffers,
    state,
    staticItems,
    live,
    visible: () => [...staticItems, ...live()],
    push(chunk: Parameters<typeof onChunk>[1]) {
      onChunk(buffers, chunk);
    },
    flush(opts?: { deferToolCalls?: boolean; now?: number }) {
      const result = collectStaticTranscriptItems(buffers, state, opts);
      staticItems.push(...result.items);
      clearSubagentsByIds(result.clearedSubagentIds);
      return result;
    },
    finish() {
      markCurrentLineAsFinished(buffers);
    },
    append(line: Line) {
      buffers.order.push(line.id);
      buffers.byId.set(line.id, line);
    },
  };
}

afterEach(() => clearAllSubagents());

describe("interleaved text promotion", () => {
  for (const tokenStreamingEnabled of [true, false]) {
    test(`keeps the complete answer after an intermediate flush (streaming=${tokenStreamingEnabled})`, () => {
      const transcript = createTranscript(tokenStreamingEnabled);
      transcript.push(reasoning("Initial reasoning."));
      transcript.flush();
      transcript.push(assistant("Visible prefix. "));
      transcript.flush();
      transcript.push(reasoning(" Late reasoning."));
      transcript.flush();

      // Neither message is complete merely because another OTID arrived.
      expect(transcript.staticItems).toEqual([]);
      expect(textOf(transcript.visible(), "assistant")).toBe(
        tokenStreamingEnabled ? "Visible prefix. " : "",
      );

      transcript.push(assistant("Previously missing suffix."));
      transcript.flush();
      expect(transcript.staticItems).toEqual([]);
      transcript.push({ message_type: "stop_reason", stop_reason: "end_turn" });
      transcript.finish();
      transcript.flush();

      expect(textOf(transcript.visible(), "assistant")).toBe(
        "Visible prefix. Previously missing suffix.",
      );
      expect(textOf(transcript.visible(), "reasoning")).toBe(
        "Initial reasoning. Late reasoning.",
      );
      expect(transcript.live()).toEqual([]);
      expect(transcript.staticItems.map((item) => item.kind)).toEqual([
        "reasoning",
        "assistant",
      ]);
      expect(transcript.flush().items).toEqual([]);
    });
  }

  test("keeps a completed paragraph live behind unfinished reasoning", () => {
    const transcript = createTranscript();
    const answer = `${"Long paragraph. ".repeat(110)}\n\nLast paragraph.`;
    transcript.push(reasoning("Reasoning first."));
    transcript.push(assistant(answer));
    expect(
      toLines(transcript.buffers).some(
        (line) => line.kind === "assistant" && line.phase === "finished",
      ),
    ).toBe(true);
    transcript.flush();

    expect(transcript.staticItems).toEqual([]);
    expect(transcript.live().map((line) => line.kind)).toEqual([
      "reasoning",
      "assistant",
      "assistant",
    ]);
    expect(textOf(transcript.visible(), "assistant")).toBe(answer);

    transcript.push(reasoning(" Still reasoning."));
    transcript.push(assistant(" Final suffix."));
    transcript.flush();
    expect(textOf(transcript.visible(), "assistant")).toBe(
      `${answer} Final suffix.`,
    );
    transcript.finish();
    transcript.flush();
    expect(transcript.staticItems.map((item) => item.id)).toEqual(
      transcript.buffers.order,
    );
    expect(transcript.live()).toEqual([]);
    expect(textOf(transcript.staticItems, "assistant")).toBe(
      `${answer} Final suffix.`,
    );
  });

  test("still promotes a safe paragraph before its own streaming tail", () => {
    const transcript = createTranscript();
    const paragraph = `${"Long paragraph. ".repeat(110)}\n\n`;
    transcript.push(assistant(`${paragraph}Tail.`));
    transcript.flush();
    expect(textOf(transcript.staticItems, "assistant")).toBe(paragraph);
    expect(textOf(transcript.live(), "assistant")).toBe("Tail.");

    transcript.push(assistant(" More tail."));
    transcript.flush();
    expect(textOf(transcript.visible(), "assistant")).toBe(
      `${paragraph}Tail. More tail.`,
    );
    expect(new Set(transcript.visible().map((item) => item.id)).size).toBe(
      transcript.visible().length,
    );
    transcript.finish();
    transcript.flush();
    expect(textOf(transcript.staticItems, "assistant")).toBe(
      `${paragraph}Tail. More tail.`,
    );
  });
});

describe("static ordering barriers", () => {
  test("does not collect or clear a Task group beyond unfinished text", () => {
    const transcript = createTranscript();
    for (const id of ["before", "after"]) {
      registerSubagent(`sub-${id}`, "general-purpose", id, `tc-${id}`);
      completeSubagent(`sub-${id}`, { success: true });
    }
    transcript.append({
      kind: "tool_call",
      id: "task-before",
      toolCallId: "tc-before",
      name: "Task",
      phase: "finished",
    });
    transcript.push(reasoning("Still receiving text."));
    transcript.append({
      kind: "tool_call",
      id: "task-after",
      toolCallId: "tc-after",
      name: "Task",
      phase: "finished",
    });

    const first = transcript.flush();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.kind).toBe("subagent_group");
    expect(first.clearedSubagentIds).toEqual(["sub-before"]);
    expect(transcript.state.emittedIds.has("task-after")).toBe(false);
    expect(getSubagentByToolCallId("tc-after")).toBeDefined();

    transcript.finish();
    const final = transcript.flush();
    expect(final.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "subagent_group",
    ]);
    expect(final.clearedSubagentIds).toEqual(["sub-after"]);
    expect(transcript.flush().items).toEqual([]);
  });

  test("keeps deferred tool results and later finished text visible once", () => {
    const transcript = createTranscript();
    transcript.append({
      kind: "tool_call",
      id: "tool",
      name: "Bash",
      phase: "finished",
    });
    transcript.push(assistant("Answer after the tool."));
    transcript.finish();
    const first = transcript.flush({ now: 100 });
    expect(first.items).toEqual([]);
    expect(first.nextCommitAt).not.toBeNull();
    expect(transcript.live().map((line) => line.kind)).toEqual([
      "tool_call",
      "assistant",
    ]);

    transcript.flush({ now: first.nextCommitAt ?? 0 });
    expect(transcript.staticItems.map((line) => line.kind)).toEqual([
      "tool_call",
      "assistant",
    ]);
    expect(transcript.live()).toEqual([]);
  });

  test("keeps status text visible without committing it above pending text", () => {
    const transcript = createTranscript();
    transcript.push(reasoning("Reasoning."));
    transcript.push({
      message_type: "event_message",
      id: "retry-status",
      event_type: "retry",
      event_data: { message: "Retrying" },
    });
    transcript.flush();
    expect(transcript.staticItems).toEqual([]);
    expect(transcript.live().map((line) => line.kind)).toEqual([
      "reasoning",
      "status",
    ]);
    transcript.finish();
    transcript.flush();
    expect(transcript.staticItems.map((line) => line.kind)).toEqual([
      "reasoning",
      "status",
    ]);
  });

  test("does not print a successful file tool twice after its eager preview", () => {
    const transcript = createTranscript();
    transcript.state.eagerCommittedPreviews.add("tc-edit");
    transcript.append({
      kind: "tool_call",
      id: "edit",
      toolCallId: "tc-edit",
      name: "Edit",
      phase: "finished",
      resultOk: true,
    });
    transcript.flush();
    expect(transcript.staticItems).toEqual([]);
    expect(transcript.live()).toEqual([]);
    expect(transcript.state.emittedIds.has("edit")).toBe(true);
  });
});
