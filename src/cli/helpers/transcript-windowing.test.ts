import { describe, expect, test } from "bun:test";
import { createBuffers, type Line, onChunk } from "./accumulator";
import {
  commitStaticItems,
  drainBackfilledItems,
  evictCommittedLines,
  STATIC_FULL_FIDELITY_WINDOW,
} from "./transcript-windowing";

function makeToolCallLine(id: string, toolCallId: string): Line {
  return {
    kind: "tool_call",
    id,
    toolCallId,
    name: "Bash",
    argsText: "{}",
    resultText: "ok",
    resultOk: true,
    phase: "finished",
  };
}

describe("evictCommittedLines", () => {
  test("drops emitted lines from byId/order and cleans per-line maps", () => {
    const b = createBuffers();
    const emitted = new Set<string>();
    const previews = new Set<string>();

    const finished = makeToolCallLine("tc-1", "call-1");
    b.byId.set("tc-1", finished);
    b.order.push("tc-1");
    b.toolCallIdToLineId.set("call-1", "tc-1");
    b.serverToolCalls.set("call-1", {
      toolName: "Bash",
      toolArgs: "{}",
      preToolUseTriggered: true,
    });
    previews.add("call-1");
    emitted.add("tc-1");

    const running: Line = {
      kind: "tool_call",
      id: "tc-2",
      toolCallId: "call-2",
      name: "Bash",
      phase: "running",
    };
    b.byId.set("tc-2", running);
    b.order.push("tc-2");
    b.toolCallIdToLineId.set("call-2", "tc-2");

    evictCommittedLines(b, emitted, previews);

    expect(b.byId.has("tc-1")).toBe(false);
    expect(b.order).toEqual(["tc-2"]);
    expect(b.toolCallIdToLineId.has("call-1")).toBe(false);
    expect(b.serverToolCalls.has("call-1")).toBe(false);
    expect(previews.has("call-1")).toBe(false);
    // Uncommitted line is untouched.
    expect(b.byId.has("tc-2")).toBe(true);
    expect(b.toolCallIdToLineId.has("call-2")).toBe(true);
  });

  test("drops the user-line otid mapping for evicted user lines", () => {
    const b = createBuffers();
    const emitted = new Set<string>();
    const user: Line = { kind: "user", id: "u-1", text: "hi", otid: "ot-1" };
    b.byId.set("u-1", user);
    b.order.push("u-1");
    b.userLineIdByOtid.set("ot-1", "u-1");
    emitted.add("u-1");

    evictCommittedLines(b, emitted);

    expect(b.byId.size).toBe(0);
    expect(b.order).toEqual([]);
    expect(b.userLineIdByOtid.size).toBe(0);
  });

  test("evicts zombie lines re-created with an already-committed id", () => {
    const b = createBuffers();
    const emitted = new Set<string>(["line-1"]);
    // Simulate a replayed chunk re-creating a committed line under the same id.
    b.byId.set("line-1", {
      kind: "assistant",
      id: "line-1",
      text: "replayed",
      phase: "streaming",
    });
    b.order.push("line-1");

    evictCommittedLines(b, emitted);

    expect(b.byId.size).toBe(0);
    expect(b.order).toEqual([]);
    // The emitted marker is retained so the commit loop keeps skipping it.
    expect(emitted.has("line-1")).toBe(true);
  });

  test("FIFO-caps secondary maps", () => {
    const b = createBuffers();
    const emitted = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      b.assistantCanonicalByMessageId.set(`m-${i}`, `c-${i}`);
    }
    evictCommittedLines(b, emitted);
    expect(b.assistantCanonicalByMessageId.size).toBe(4096);
    // Oldest entries evicted first.
    expect(b.assistantCanonicalByMessageId.has("m-0")).toBe(false);
    expect(b.assistantCanonicalByMessageId.has("m-4999")).toBe(true);
  });
});

describe("commitStaticItems", () => {
  function assistantItem(id: string, textLength: number): Line {
    return {
      kind: "assistant",
      id,
      text: "x".repeat(textLength),
      phase: "finished",
    };
  }

  test("trims heavy payloads only outside the trailing window and frontier", () => {
    const old: Line[] = [];
    for (let i = 0; i < STATIC_FULL_FIDELITY_WINDOW + 10; i++) {
      old.push(assistantItem(`a-${i}`, 50_000));
    }
    const fresh = [assistantItem("fresh", 50_000)];
    const renderedCount = old.length; // everything previously committed rendered

    const combined = commitStaticItems(old, fresh, renderedCount);

    expect(combined).toHaveLength(old.length + 1);
    // Items older than the window are trimmed.
    const trimmed = combined[0] as Extract<Line, { kind: "assistant" }>;
    expect(trimmed.text.length).toBeLessThan(20_000);
    expect(trimmed.text).toContain("chars trimmed");
    // Items inside the trailing window keep full fidelity.
    const inWindow = combined[combined.length - 2] as Extract<
      Line,
      { kind: "assistant" }
    >;
    expect(inWindow.text).toHaveLength(50_000);
    // Freshly committed items are never trimmed in the same pass.
    const freshItem = combined[combined.length - 1] as Extract<
      Line,
      { kind: "assistant" }
    >;
    expect(freshItem.text).toHaveLength(50_000);
  });

  test("respects the rendered frontier even beyond the window", () => {
    const prev: Line[] = [];
    for (let i = 0; i < STATIC_FULL_FIDELITY_WINDOW + 50; i++) {
      prev.push(assistantItem(`a-${i}`, 50_000));
    }
    // renderedCount 0: nothing rendered yet (e.g. bulk backfill pre-paint).
    const combined = commitStaticItems(prev, [], 0);
    for (const item of combined) {
      expect((item as Extract<Line, { kind: "assistant" }>).text).toHaveLength(
        50_000,
      );
    }
  });

  test("is idempotent across passes", () => {
    const prev: Line[] = [];
    for (let i = 0; i < STATIC_FULL_FIDELITY_WINDOW + 5; i++) {
      prev.push(assistantItem(`a-${i}`, 50_000));
    }
    const once = commitStaticItems(prev, [], prev.length);
    const first = (once[0] as Extract<Line, { kind: "assistant" }>).text;
    const twice = commitStaticItems(once, [], once.length);
    expect((twice[0] as Extract<Line, { kind: "assistant" }>).text).toBe(first);
    expect(twice[0]).toBe(once[0]);
  });

  test("drops streaming state and precomputed diffs from old items", () => {
    const toolItems = Array.from(
      { length: STATIC_FULL_FIDELITY_WINDOW + 1 },
      (_, i) => ({
        kind: "tool_call" as const,
        id: `t-${i}`,
        toolCallId: `call-${i}`,
        name: "Bash",
        argsText: "a".repeat(10_000),
        resultText: "r".repeat(10_000),
        phase: "finished" as const,
        streaming: {
          tailLines: [],
          partialLine: "",
          partialIsStderr: false,
          totalLineCount: 0,
          startTime: 0,
        },
      }),
    );
    const combined = commitStaticItems(toolItems, [], toolItems.length);
    const trimmed = combined[0];
    expect(trimmed).toBeDefined();
    if (!trimmed) return;
    expect(trimmed.streaming).toBeUndefined();
    expect(trimmed.resultText?.length).toBeLessThan(5_000);
    expect(trimmed.argsText?.length).toBeLessThan(3_000);
  });
});

describe("drainBackfilledItems", () => {
  test("returns copies of all buffered lines and resets per-line state", () => {
    const b = createBuffers();
    const emitted = new Set<string>();
    b.byId.set("u-1", { kind: "user", id: "u-1", text: "hello" });
    b.order.push("u-1");
    b.byId.set("tc-1", makeToolCallLine("tc-1", "call-1"));
    b.order.push("tc-1");
    b.toolCallIdToLineId.set("call-1", "tc-1");
    b.assistantCanonicalByMessageId.set("m-1", "c-1");

    const items = drainBackfilledItems(b, emitted);

    expect(items.map((i) => i.id)).toEqual(["u-1", "tc-1"]);
    expect(emitted.has("u-1")).toBe(true);
    expect(emitted.has("tc-1")).toBe(true);
    // Copies are detached from the (now-cleared) buffers.
    expect(items[0]).not.toBe(undefined);
    expect(b.byId.size).toBe(0);
    expect(b.order).toEqual([]);
    expect(b.toolCallIdToLineId.size).toBe(0);
    expect(b.assistantCanonicalByMessageId.size).toBe(0);
  });
});

describe("drainBackfilledItems with unfinished lines", () => {
  test("retains pending-approval lines and their tool-call mapping", () => {
    const b = createBuffers();
    const emitted = new Set<string>();
    // Finished history line: drains to static.
    b.byId.set("u-1", { kind: "user", id: "u-1", text: "hello" });
    b.order.push("u-1");
    // Pending approval request at the history tail: must stay live.
    const pending: Line = {
      kind: "tool_call",
      id: "msg-9",
      toolCallId: "call-9",
      name: "Bash",
      argsText: "{}",
      phase: "ready",
    };
    b.byId.set("msg-9", pending);
    b.order.push("msg-9");
    b.toolCallIdToLineId.set("call-9", "msg-9");

    const items = drainBackfilledItems(b, emitted);

    expect(items.map((i) => i.id)).toEqual(["u-1"]);
    expect(emitted.has("u-1")).toBe(true);
    expect(emitted.has("msg-9")).toBe(false);
    // The unfinished line and its mapping survive so the tool result can
    // still attach after the approval is decided.
    expect(b.order).toEqual(["msg-9"]);
    expect(b.byId.get("msg-9")).toBe(pending);
    expect(b.toolCallIdToLineId.get("call-9")).toBe("msg-9");
  });
});

describe("evicted-line id reuse", () => {
  test("a later content block sharing a committed message id gets a fresh line", () => {
    const b = createBuffers();
    const emitted = new Set<string>();

    // First text block streams under message id msg-1 / otid ot-1.
    onChunk(b, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "ot-1",
      content: "first block",
      date: new Date().toISOString(),
    } as Parameters<typeof onChunk>[1]);
    const first = b.byId.get("msg-1");
    expect(first?.kind).toBe("assistant");
    if (!first || first.kind !== "assistant")
      throw new Error("expected first block line");

    // The block finishes and commits to static; eviction drops the line.
    b.byId.set("msg-1", { ...first, phase: "finished" });
    emitted.add("msg-1");
    evictCommittedLines(b, emitted);
    expect(b.byId.has("msg-1")).toBe(false);

    // Anthropic [text, thinking, text]: the second text block shares the
    // message id but arrives under a new otid. It must get a fresh line —
    // reusing the emitted id would make the block vanish from the transcript.
    onChunk(b, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "ot-2",
      content: "second block",
      date: new Date().toISOString(),
    } as Parameters<typeof onChunk>[1]);

    const second = b.byId.get("ot-2");
    expect(second?.kind).toBe("assistant");
    expect(second && "text" in second ? second.text : undefined).toContain(
      "second block",
    );
    expect(b.byId.has("msg-1")).toBe(false);
  });
});
