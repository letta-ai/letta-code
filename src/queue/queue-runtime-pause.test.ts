/**
 * QueueRuntime pause/resume: user messages parked by an interrupt stay
 * visible but are skipped by every dequeue path; system items keep flowing.
 */
import { describe, expect, test } from "bun:test";
import {
  type QueueBlockedReason,
  type QueueItem,
  QueueRuntime,
} from "@/queue/queue-runtime";

type EnqueueInput = Parameters<QueueRuntime["enqueue"]>[0];

function userMsg(text: string): EnqueueInput {
  return { kind: "message", source: "user", content: text } as EnqueueInput;
}

function notification(text = "<notification/>"): EnqueueInput {
  return {
    kind: "task_notification",
    source: "task_notification",
    text,
  } as EnqueueInput;
}

function textOf(item: QueueItem): string {
  return item.kind === "message" ? String(item.content) : item.text;
}

describe("QueueRuntime.pause", () => {
  test("parks only user messages and reports the count", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("a"));
    q.enqueue(notification());
    q.enqueue(userMsg("b"));

    expect(q.pause()).toBe(2);
    expect(q.length).toBe(3);
    expect(q.readyLength).toBe(1);
    expect(q.pausedCount).toBe(2);
    expect(q.peekReady().map(textOf)).toEqual(["<notification/>"]);
    // Paused items remain visible for display.
    expect(q.items.map((i) => Boolean(i.paused))).toEqual([true, false, true]);
  });

  test("is idempotent and does not touch items enqueued after the pause", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("before"));
    expect(q.pause()).toBe(1);
    expect(q.pause()).toBe(0);
    q.enqueue(userMsg("after"));
    expect(q.readyLength).toBe(1);
    expect(q.peekReady().map(textOf)).toEqual(["after"]);
  });

  test("fires onPauseChanged on pause and resume, not on no-op calls", () => {
    const changes: Array<[number, number]> = [];
    const q = new QueueRuntime({
      callbacks: {
        onPauseChanged: (pausedCount, queueLen) =>
          changes.push([pausedCount, queueLen]),
      },
    });
    q.enqueue(userMsg("a"));
    q.enqueue(notification());
    q.pause();
    q.pause();
    q.resume();
    q.resume();
    expect(changes).toEqual([
      [1, 2],
      [0, 2],
    ]);
  });
});

describe("dequeue paths skip paused items", () => {
  test("consumeItems takes the first n ready items and leaves paused ones", () => {
    const dequeued: string[][] = [];
    const q = new QueueRuntime({
      callbacks: {
        onDequeued: (batch) => dequeued.push(batch.items.map(textOf)),
      },
    });
    q.enqueue(userMsg("parked"));
    q.enqueue(notification("n1"));
    q.enqueue(notification("n2"));
    q.pause();

    const batch = q.consumeItems(5);
    expect(batch?.items.map(textOf)).toEqual(["n1", "n2"]);
    expect(batch?.queueLenAfter).toBe(1);
    expect(dequeued).toEqual([["n1", "n2"]]);
    expect(q.items.map(textOf)).toEqual(["parked"]);
  });

  test("consumeItems returns null when only paused items remain", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("parked"));
    q.pause();
    expect(q.consumeItems(1)).toBeNull();
    expect(q.length).toBe(1);
  });

  test("tryDequeue drains ready coalescables around a paused item", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("parked"));
    q.enqueue(notification("n1"));
    q.enqueue(userMsg("typed after esc"));
    q.pause();
    // Both user messages above are now parked; this one arrives afterwards
    // and is ready, so the batch skips the parked items around it.
    q.enqueue(userMsg("typed after pause"));

    const batch = q.tryDequeue(null);
    expect(batch?.items.map(textOf)).toEqual(["n1", "typed after pause"]);
    expect(q.items.map(textOf)).toEqual(["parked", "typed after esc"]);
  });

  test("tryDequeue reports paused_by_user once when only paused items remain", () => {
    const blocked: QueueBlockedReason[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (reason) => blocked.push(reason) },
    });
    q.enqueue(userMsg("parked"));
    q.pause();

    expect(q.tryDequeue(null)).toBeNull();
    expect(q.tryDequeue(null)).toBeNull();
    expect(blocked).toEqual(["paused_by_user"]);
  });

  test("tryDequeue takes a ready barrier alone even behind a paused message", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("parked"));
    q.enqueue({
      kind: "approval_result",
      source: "system",
      text: "ok",
    } as EnqueueInput);
    q.enqueue(notification("n1"));
    q.pause();

    const batch = q.tryDequeue(null);
    expect(batch?.items.map((i) => i.kind)).toEqual(["approval_result"]);
    expect(q.items.map((i) => i.kind)).toEqual([
      "message",
      "task_notification",
    ]);
  });
});

describe("QueueRuntime.resume", () => {
  test("releases parked items in their original order ahead of later arrivals", () => {
    const q = new QueueRuntime();
    q.enqueue(userMsg("first"));
    q.enqueue(userMsg("second"));
    q.pause();
    q.enqueue(userMsg("third"));

    expect(q.resume()).toBe(2);
    expect(q.pausedCount).toBe(0);
    const batch = q.tryDequeue(null);
    expect(batch?.items.map(textOf)).toEqual(["first", "second", "third"]);
    expect(q.isEmpty).toBe(true);
  });

  test("resume after a paused_by_user block lets the next tryDequeue re-emit reasons", () => {
    const blocked: QueueBlockedReason[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (reason) => blocked.push(reason) },
    });
    q.enqueue(userMsg("parked"));
    q.pause();
    q.tryDequeue(null);
    q.resume();
    q.tryDequeue("streaming");
    expect(blocked).toEqual(["paused_by_user", "streaming"]);
  });

  test("removeItem and clear work on paused items", () => {
    const q = new QueueRuntime();
    const a = q.enqueue(userMsg("a"));
    q.enqueue(userMsg("b"));
    q.pause();
    expect(q.removeItem(a?.id ?? "")?.paused).toBe(true);
    expect(q.pausedCount).toBe(1);
    q.clear("cancelled");
    expect(q.length).toBe(0);
    expect(q.pausedCount).toBe(0);
  });
});
