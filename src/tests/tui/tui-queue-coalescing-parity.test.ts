/**
 * Golden parity test: buildContentFromQueueBatch (new QueueRuntime path) must
 * produce identical output to buildQueuedContentParts (current messageQueue path)
 * for the same logical input.
 *
 * This test must pass before any state is swapped in the PRQ4 cutover.
 * If these two functions ever diverge, the cutover has introduced a regression.
 */

import { describe, expect, test } from "bun:test";
import type { QueuedMessage } from "../../cli/helpers/messageQueueBridge";
import {
  buildContentFromQueueBatch,
  buildQueuedContentParts,
} from "../../cli/helpers/queuedMessageParts";
import { QueueRuntime } from "../../queue/queueRuntime";

// ── Helpers ───────────────────────────────────────────────────────

/** Build a DequeuedBatch from a list of (kind, text) pairs via QueueRuntime. */
function makeBatch(
  items: Array<{ kind: "user" | "task_notification"; text: string }>,
) {
  const q = new QueueRuntime({ maxItems: Infinity });
  for (const item of items) {
    if (item.kind === "task_notification") {
      q.enqueue({
        kind: "task_notification",
        source: "task_notification",
        text: item.text,
      } as Parameters<typeof q.enqueue>[0]);
    } else {
      q.enqueue({
        kind: "message",
        source: "user",
        content: item.text,
      } as Parameters<typeof q.enqueue>[0]);
    }
  }
  const batch = q.consumeItems(items.length);
  if (!batch) throw new Error("consumeItems returned null for non-empty queue");
  return batch;
}

/** Build the QueuedMessage[] equivalent for the old path. */
function makeQueued(
  items: Array<{ kind: "user" | "task_notification"; text: string }>,
): QueuedMessage[] {
  return items.map((item) => ({
    kind: item.kind,
    text: item.text,
  }));
}

// ── Fixtures ──────────────────────────────────────────────────────

const SINGLE_USER = [{ kind: "user" as const, text: "hello world" }];

const SINGLE_NOTIF = [
  {
    kind: "task_notification" as const,
    text: "<task-notification>done</task-notification>",
  },
];

const USER_THEN_NOTIF = [
  { kind: "user" as const, text: "first message" },
  {
    kind: "task_notification" as const,
    text: "<task-notification>bg task done</task-notification>",
  },
];

const NOTIF_THEN_USER = [
  {
    kind: "task_notification" as const,
    text: "<task-notification>prelude</task-notification>",
  },
  { kind: "user" as const, text: "follow-up" },
];

const THREE_ITEMS = [
  { kind: "user" as const, text: "msg one" },
  {
    kind: "task_notification" as const,
    text: "<task-notification>mid notif</task-notification>",
  },
  { kind: "user" as const, text: "msg three" },
];

const MULTILINE_USER = [
  { kind: "user" as const, text: "line one\nline two\nline three" },
];

// Intentionally unused — documents the empty-batch case tested inline below
const _EMPTY: Array<{ kind: "user" | "task_notification"; text: string }> = [];

// ── Tests ─────────────────────────────────────────────────────────

describe("buildContentFromQueueBatch parity with buildQueuedContentParts", () => {
  test("single user message", () => {
    const batch = makeBatch(SINGLE_USER);
    const queued = makeQueued(SINGLE_USER);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("single task_notification", () => {
    const batch = makeBatch(SINGLE_NOTIF);
    const queued = makeQueued(SINGLE_NOTIF);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("user then task_notification (coalesced batch)", () => {
    const batch = makeBatch(USER_THEN_NOTIF);
    const queued = makeQueued(USER_THEN_NOTIF);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("task_notification then user (reverse order)", () => {
    const batch = makeBatch(NOTIF_THEN_USER);
    const queued = makeQueued(NOTIF_THEN_USER);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("three items: user + notif + user", () => {
    const batch = makeBatch(THREE_ITEMS);
    const queued = makeQueued(THREE_ITEMS);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("multiline user message", () => {
    const batch = makeBatch(MULTILINE_USER);
    const queued = makeQueued(MULTILINE_USER);
    expect(buildContentFromQueueBatch(batch)).toEqual(
      buildQueuedContentParts(queued),
    );
  });

  test("empty batch returns []", () => {
    // Empty queue: consumeItems returns null, so test the null→[] path directly
    const q = new QueueRuntime({ maxItems: Infinity });
    q.enqueue({ kind: "message", source: "user", content: "x" } as Parameters<
      typeof q.enqueue
    >[0]);
    const batch = q.consumeItems(1);
    if (!batch) throw new Error("expected non-null batch");
    // Override items to empty to test the null-merged → [] return
    const emptyBatch = { ...batch, items: [] };
    expect(buildContentFromQueueBatch(emptyBatch)).toEqual(
      buildQueuedContentParts([]),
    );
  });

  test("output is non-empty array for non-empty input", () => {
    const batch = makeBatch(SINGLE_USER);
    const result = buildContentFromQueueBatch(batch);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });

  test("separator \\n between items matches old path", () => {
    const batch = makeBatch(USER_THEN_NOTIF);
    const queued = makeQueued(USER_THEN_NOTIF);
    const newResult = buildContentFromQueueBatch(batch);
    const oldResult = buildQueuedContentParts(queued);
    // Both should have a text separator part between the two items
    expect(newResult).toEqual(oldResult);
    // Verify separator is present (text part with \n between items)
    const parts = newResult as Array<{ type: string; text?: string }>;
    const sepIdx = parts.findIndex((p) => p.type === "text" && p.text === "\n");
    expect(sepIdx).toBeGreaterThan(0);
  });
});

describe("toQueuedMsg", () => {
  // Imported lazily here to keep test readable
  test("user message with string content round-trips to QueuedMessage", async () => {
    const { toQueuedMsg } = await import(
      "../../cli/helpers/queuedMessageParts"
    );
    const item = {
      id: "item-1",
      kind: "message" as const,
      source: "user" as const,
      content: "hello",
      enqueuedAt: 0,
    };
    expect(toQueuedMsg(item)).toEqual({ kind: "user", text: "hello" });
  });

  test("task_notification round-trips to QueuedMessage", async () => {
    const { toQueuedMsg } = await import(
      "../../cli/helpers/queuedMessageParts"
    );
    const item = {
      id: "item-2",
      kind: "task_notification" as const,
      source: "task_notification" as const,
      text: "<task-notification>done</task-notification>",
      enqueuedAt: 0,
    };
    expect(toQueuedMsg(item)).toEqual({
      kind: "task_notification",
      text: "<task-notification>done</task-notification>",
    });
  });

  test("user message with content parts extracts text parts", async () => {
    const { toQueuedMsg } = await import(
      "../../cli/helpers/queuedMessageParts"
    );
    const item = {
      id: "item-3",
      kind: "message" as const,
      source: "user" as const,
      content: [
        { type: "text" as const, text: "hello " },
        { type: "text" as const, text: "world" },
      ],
      enqueuedAt: 0,
    };
    expect(toQueuedMsg(item)).toEqual({ kind: "user", text: "hello world" });
  });
});
