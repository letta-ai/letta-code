import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type Buffers,
  createBuffers,
  findLastAssistantText,
  markCurrentLineAsFinished,
  markIncompleteToolsAsCancelled,
  onChunk,
  toLines,
} from "./accumulator";

function assistant(text: string, otid = "answer"): LettaStreamingResponse {
  return {
    message_type: "assistant_message",
    id: "answer-message",
    otid,
    content: [{ type: "text", text }],
  } as LettaStreamingResponse;
}

function reasoning(text: string): LettaStreamingResponse {
  return {
    message_type: "reasoning_message",
    id: "reasoning-message",
    otid: "reasoning",
    reasoning: text,
  } as LettaStreamingResponse;
}

function retry(buffers: Buffers): void {
  onChunk(buffers, {
    message_type: "event_message",
    id: "retry-event",
    event_type: "retry",
    event_data: { reason: "upstream_error" },
  });
}

function textPhases(buffers: Buffers): string[] {
  return toLines(buffers)
    .filter((line) => line.kind === "assistant" || line.kind === "reasoning")
    .map((line) => line.phase);
}

describe("interleaved text lifecycle", () => {
  for (const tokenStreamingEnabled of [false, true]) {
    test(`keeps both blocks writable through reasoning interleaving (streaming=${tokenStreamingEnabled})`, () => {
      const buffers = createBuffers();
      buffers.tokenStreamingEnabled = tokenStreamingEnabled;
      onChunk(buffers, reasoning("Initial thought. "));
      onChunk(buffers, assistant("Visible prefix. "));
      onChunk(buffers, reasoning("Late thought.\n\n"));

      // Neither row is safe for immutable terminal output at this point.
      expect(textPhases(buffers)).toEqual(["streaming", "streaming"]);
      onChunk(buffers, assistant("Previously missing suffix."));
      expect(textPhases(buffers)).toEqual(["streaming", "streaming"]);

      markCurrentLineAsFinished(buffers);
      expect(textPhases(buffers)).toEqual(["finished", "finished"]);
      expect(findLastAssistantText(toLines(buffers))).toBe(
        "Visible prefix. Previously missing suffix.",
      );
      expect(buffers.lastAssistantMessage).toBe(
        "Visible prefix. Previously missing suffix.",
      );
      expect(buffers.lastReasoning).toBe("Initial thought. Late thought.");
    });
  }

  test("retry events do not finalize text before resumed chunks", () => {
    const buffers = createBuffers();
    onChunk(buffers, reasoning("Think "));
    onChunk(buffers, assistant("Before "));
    retry(buffers);
    expect(textPhases(buffers)).toEqual(["streaming", "streaming"]);

    onChunk(buffers, reasoning("again"));
    onChunk(buffers, assistant("retry"));
    markCurrentLineAsFinished(buffers);
    expect(buffers.lastReasoning).toBe("Think again");
    expect(buffers.lastAssistantMessage).toBe("Before retry");
  });

  test("completion finalizes all text when lastOtid is a status event", () => {
    const buffers = createBuffers();
    onChunk(buffers, reasoning("Thought\n\n"));
    onChunk(buffers, assistant("Answer"));
    retry(buffers);
    markCurrentLineAsFinished(buffers);
    expect(textPhases(buffers)).toEqual(["finished", "finished"]);
    expect(buffers.lastReasoning).toBe("Thought");
    expect(buffers.lastAssistantMessage).toBe("Answer");
  });

  for (const otid of [undefined, "tool-otid"]) {
    test(`approval after a status event finalizes all text (otid=${otid})`, () => {
      const buffers = createBuffers();
      onChunk(buffers, reasoning("I should read a file."));
      onChunk(buffers, assistant("Reading now."));
      retry(buffers);
      onChunk(buffers, {
        message_type: "approval_request_message",
        id: "approval",
        otid,
        tool_call: { tool_call_id: "read-tool", name: "Read", arguments: "{}" },
      } as LettaStreamingResponse);

      expect(textPhases(buffers)).toEqual(["finished", "finished"]);
      expect(buffers.lastReasoning).toBe("I should read a file.");
      expect(buffers.lastAssistantMessage).toBe("Reading now.");
      expect(buffers.byId.get("read-tool")).toMatchObject({
        kind: "tool_call",
        phase: "ready",
      });
    });
  }

  test("user boundary finalizes all text even if its OTID matches the last text", () => {
    const buffers = createBuffers();
    onChunk(buffers, reasoning("Reasoning"));
    onChunk(buffers, assistant("Answer"));
    onChunk(buffers, {
      message_type: "user_message",
      otid: buffers.lastOtid,
      content: [{ type: "text", text: "Next input" }],
    } as LettaStreamingResponse);
    expect(textPhases(buffers)).toEqual(["finished", "finished"]);
  });

  test("recoverable interruption keeps all text open for a resume", () => {
    const buffers = createBuffers();
    onChunk(buffers, reasoning("Before "));
    onChunk(buffers, assistant("Prefix "));
    markIncompleteToolsAsCancelled(buffers, false, "stream_error", true);
    expect(textPhases(buffers)).toEqual(["streaming", "streaming"]);
    onChunk(buffers, reasoning("resume"));
    onChunk(buffers, assistant("suffix"));
    markCurrentLineAsFinished(buffers);
    expect(buffers.lastReasoning).toBe("Before resume");
    expect(buffers.lastAssistantMessage).toBe("Prefix suffix");
  });

  test("terminal interruption finishes all text and ignores stale chunks", () => {
    const buffers = createBuffers();
    onChunk(buffers, reasoning("Before stop"));
    onChunk(buffers, assistant("Partial answer"));
    markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
    onChunk(buffers, assistant(" stale suffix"));
    expect(textPhases(buffers)).toEqual(["finished", "finished"]);
    expect(buffers.lastAssistantMessage).toBe("Partial answer");
    expect(buffers.lastReasoning).toBe("Before stop");
  });

  test("terminal text cleanup leaves a running tool untouched", () => {
    const buffers = createBuffers();
    onChunk(buffers, assistant("Answer"));
    buffers.byId.set("running-tool", {
      kind: "tool_call",
      id: "running-tool",
      phase: "running",
    });
    buffers.order.push("running-tool");
    buffers.lastOtid = "running-tool";
    markCurrentLineAsFinished(buffers);
    expect(textPhases(buffers)).toEqual(["finished"]);
    expect(buffers.byId.get("running-tool")).toMatchObject({
      phase: "running",
    });
  });
});
