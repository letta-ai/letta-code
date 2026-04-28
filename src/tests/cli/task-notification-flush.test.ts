import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NotificationBuffer } from "../../cli/helpers/taskNotifications";
import { appendTaskNotificationEventsToBuffer } from "../../cli/helpers/taskNotifications";

// ---------------------------------------------------------------------------
// Helper-level behavioral tests
// ---------------------------------------------------------------------------

describe("appendTaskNotificationEventsToBuffer", () => {
  const makeBuffer = (): NotificationBuffer => ({
    byId: new Map(),
    order: [],
  });

  let idCounter = 0;
  const generateId = () => `event_${++idCounter}`;

  test("writes events to buffer and calls flush", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    const result = appendTaskNotificationEventsToBuffer(
      ["Agent completed", "Reflection done"],
      buffer,
      generateId,
      flush,
    );

    expect(result).toBe(true);
    expect(buffer.order).toHaveLength(2);
    expect(buffer.byId.size).toBe(2);
    expect(flush).toHaveBeenCalledTimes(1);

    // Verify event shape
    const firstId = buffer.order[0];
    expect(firstId).toBeDefined();
    const first = buffer.byId.get(firstId as string) as Record<string, unknown>;
    expect(first.kind).toBe("event");
    expect(first.eventType).toBe("task_notification");
    expect(first.phase).toBe("finished");
    expect(first.summary).toBe("Agent completed");
  });

  test("flush is called exactly once even with multiple summaries", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    appendTaskNotificationEventsToBuffer(
      ["one", "two", "three"],
      buffer,
      generateId,
      flush,
    );

    expect(buffer.order).toHaveLength(3);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test("returns false and skips flush for empty summaries", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    const result = appendTaskNotificationEventsToBuffer(
      [],
      buffer,
      generateId,
      flush,
    );

    expect(result).toBe(false);
    expect(buffer.order).toHaveLength(0);
    expect(flush).not.toHaveBeenCalled();
  });

  test("works without flush callback (non-background caller)", () => {
    const buffer = makeBuffer();

    const result = appendTaskNotificationEventsToBuffer(
      ["Agent completed"],
      buffer,
      generateId,
    );

    expect(result).toBe(true);
    expect(buffer.order).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration wiring: onComplete callbacks → appendTaskNotificationEvents
//
// These verify that the actual background subagent completion sites in App.tsx
// route through the flush-equipped appendTaskNotificationEvents, and that the
// ref indirection connecting it to refreshDerived is wired correctly.
// ---------------------------------------------------------------------------

describe("background onComplete → flush wiring in App.tsx", () => {
  const readSource = () =>
    readFileSync(
      fileURLToPath(new URL("../../cli/App.tsx", import.meta.url)),
      "utf-8",
    );

  test("appendTaskNotificationEvents delegates to appendTaskNotificationEventsToBuffer with a flush arg", () => {
    const source = readSource();

    // The useCallback must call the extracted helper
    expect(source).toContain("appendTaskNotificationEventsToBuffer(");

    // It must pass refreshDerivedRef as the flush callback (4th arg).
    // Match the delegation pattern: the flush lambda references refreshDerivedRef.
    expect(source).toContain("refreshDerivedRef.current?.");
  });

  test("refreshDerivedRef is assigned after refreshDerived is defined", () => {
    const source = readSource();

    const refDecl = source.indexOf("const refreshDerivedRef = useRef");
    const derivedDecl = source.indexOf("const refreshDerived = useCallback");
    const refAssign = source.indexOf(
      "refreshDerivedRef.current = refreshDerived",
    );

    expect(refDecl).toBeGreaterThan(-1);
    expect(derivedDecl).toBeGreaterThan(-1);
    expect(refAssign).toBeGreaterThan(-1);

    // Declaration order: ref declared before refreshDerived, assignment after
    expect(refDecl).toBeLessThan(derivedDecl);
    expect(refAssign).toBeGreaterThan(derivedDecl);
  });

  test("reflection onComplete calls appendTaskNotificationEvents", () => {
    const source = readSource();

    const reflectionBlock = source.indexOf('subagentType: "reflection"');
    expect(reflectionBlock).toBeGreaterThan(-1);

    const onCompleteIdx = source.indexOf("onComplete:", reflectionBlock);
    expect(onCompleteIdx).toBeGreaterThan(-1);

    const onCompleteWindow = source.slice(onCompleteIdx, onCompleteIdx + 1400);
    expect(onCompleteWindow).toContain("await handleMemorySubagentCompletion(");
    expect(onCompleteWindow).toContain("appendTaskNotificationEvents(");
  });
});
