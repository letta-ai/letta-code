import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  createBuffers,
  type Line,
  markCurrentLineAsFinished,
  onChunk,
  toLines,
} from "@/cli/helpers/accumulator";

function reasoning(otid: string, delta: string): LettaStreamingResponse {
  return {
    message_type: "reasoning_message",
    otid,
    reasoning: delta,
  } as unknown as LettaStreamingResponse;
}

function assistant(otid: string, delta: string): LettaStreamingResponse {
  return {
    message_type: "assistant_message",
    otid,
    content: delta,
  } as unknown as LettaStreamingResponse;
}

function textOf(line: Line | undefined): string {
  if (!line) throw new Error("missing line");
  if (line.kind === "assistant" || line.kind === "reasoning") return line.text;
  throw new Error(`unexpected line kind: ${line.kind}`);
}

function nothingContentStreaming(b: ReturnType<typeof createBuffers>): boolean {
  return toLines(b).every((line) => {
    if (line.kind !== "assistant" && line.kind !== "reasoning") return true;
    return line.phase === "finished";
  });
}

describe("interleaved reasoning/assistant blocks", () => {
  test("R -> A -> R -> A merges re-entered deltas into one live line per block", () => {
    const b = createBuffers("agent-1");

    onChunk(b, reasoning("R1", "first "));
    onChunk(b, reasoning("R1", "second"));
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "streaming",
      text: "first second",
    });

    // The assistant start does NOT finalize the reasoning block: an OTID
    // switch proves interleaving, not closure.
    onChunk(b, assistant("A1", "say"));
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "streaming",
      text: "first second",
    });
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "streaming",
      text: "say",
    });

    // The resumed reasoning fragment merges into the still-live reasoning
    // line: one row, no continuation machinery, no lost bytes.
    onChunk(b, reasoning("R1", " ignored-tail"));
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "streaming",
      text: "first second ignored-tail",
    });
    expect(b.byId.has("R1-cont-1")).toBe(false);
    expect(b.byId.has("A1-cont-1")).toBe(false);

    onChunk(b, assistant("A1", " bye"));
    onChunk(b, assistant("A1", " world"));
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "streaming",
      text: "say bye world",
    });

    markCurrentLineAsFinished(b);
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "first second ignored-tail",
    });
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "say bye world",
    });
    expect(nothingContentStreaming(b)).toBe(true);
    // Hooks see the complete merged block.
    expect(b.lastReasoning).toBe("first second ignored-tail");
  });

  test("behaves the same with aggressive token streaming enabled", () => {
    const b = createBuffers("agent-1");
    b.tokenStreamingEnabled = true;

    onChunk(b, reasoning("R1", "first "));
    onChunk(b, assistant("A1", "say"));
    onChunk(b, reasoning("R1", " tail"));
    onChunk(b, assistant("A1", " bye"));
    onChunk(b, assistant("A1", " world"));

    markCurrentLineAsFinished(b);

    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "say bye world",
    });
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "first  tail",
    });
    expect(nothingContentStreaming(b)).toBe(true);
  });

  test("immediate stop_reason after the final re-entry finalizes merged blocks", () => {
    const b = createBuffers("agent-1");

    onChunk(b, reasoning("R1", "r1 "));
    onChunk(b, reasoning("R1", "r2"));
    onChunk(b, assistant("A1", "say"));
    onChunk(b, reasoning("R1", " tail"));
    onChunk(b, assistant("A1", " bye world"));
    markCurrentLineAsFinished(b);

    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "say bye world",
    });
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "r1 r2 tail",
    });
    expect(b.lastReasoning).toBe("r1 r2 tail");
    expect(nothingContentStreaming(b)).toBe(true);
  });

  test("A -> R -> A merges the resumed assistant tail into the live assistant line", () => {
    const b = createBuffers("agent-1");

    onChunk(b, assistant("A1", "hello"));
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "streaming",
      text: "hello",
    });

    // A reasoning block between the assistant chunks does not close A1.
    onChunk(b, reasoning("R2", "thinking more"));
    expect(b.byId.get("A1")).toMatchObject({ phase: "streaming" });
    expect(b.byId.get("R2")).toMatchObject({ phase: "streaming" });

    onChunk(b, assistant("A1", ", and world"));
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "streaming",
      text: "hello, and world",
    });

    markCurrentLineAsFinished(b);
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "hello, and world",
    });
    expect(b.byId.get("R2")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "thinking more",
    });
    expect(b.lastAssistantMessage).toBe("hello, and world");
    expect(nothingContentStreaming(b)).toBe(true);
  });

  test("R -> A -> R -> stop leaves nothing streaming and merges the fragment", () => {
    const b = createBuffers("agent-1");

    onChunk(b, reasoning("R1", "r1"));
    onChunk(b, assistant("A1", "say"));
    onChunk(b, reasoning("R1", " tail"));
    markCurrentLineAsFinished(b);

    expect(nothingContentStreaming(b)).toBe(true);
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "r1 tail",
    });
    expect(b.byId.get("A1")).toMatchObject({ phase: "finished" });
  });

  test("A -> R -> A -> stop leaves nothing streaming and merges the tail", () => {
    const b = createBuffers("agent-1");

    onChunk(b, assistant("A1", "hello"));
    onChunk(b, reasoning("R2", "thinking"));
    onChunk(b, assistant("A1", ", world"));
    markCurrentLineAsFinished(b);

    expect(nothingContentStreaming(b)).toBe(true);
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "hello, world",
    });
    expect(b.byId.get("R2")).toMatchObject({ phase: "finished" });
  });

  test("multiple reasoning re-entries merge into the same line (R -> A -> R -> A -> R)", () => {
    const b = createBuffers("agent-1");

    onChunk(b, reasoning("R1", "r1"));
    onChunk(b, assistant("A1", "say"));
    onChunk(b, reasoning("R1", " tail1"));
    onChunk(b, assistant("A1", " bye"));
    onChunk(b, reasoning("R1", " tail2"));
    markCurrentLineAsFinished(b);

    // Both fragments land on the single reasoning line; nothing is dropped.
    expect(b.byId.get("R1")).toMatchObject({
      kind: "reasoning",
      phase: "finished",
      text: "r1 tail1 tail2",
    });
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "finished",
      text: "say bye",
    });
    expect(nothingContentStreaming(b)).toBe(true);
  });

  test("token streaming promotes a long re-entered tail via paragraph splits", () => {
    const b = createBuffers("agent-1");
    b.tokenStreamingEnabled = true;

    onChunk(b, assistant("A1", "intro "));
    onChunk(b, reasoning("R2", "more"));
    // The assistant block resumes with a long paragraph-bounded tail:
    // trySplitContent promotes the completed prefix instead of keeping one
    // unbounded streaming line.
    onChunk(b, assistant("A1", `para one\n\n${"x".repeat(1500)}`));

    expect(b.byId.has("A1-split-0")).toBe(true);
    expect(b.byId.get("A1")).toMatchObject({
      kind: "assistant",
      phase: "streaming",
    });
    expect(textOf(b.byId.get("A1"))).toBe("x".repeat(1500));
  });
});
