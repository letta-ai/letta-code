/**
 * Tests for the static transcript sync protocol types (LSS1).
 *
 * Verifies structural correctness, discriminant exhaustiveness, and
 * membership in WireMessage / WsProtocolEvent unions.
 */

import { describe, expect, test } from "bun:test";
import type {
  QueueSnapshotMessage,
  SyncCompleteMessage,
  TranscriptBackfillMessage,
  TranscriptSupplementMessage,
  WireMessage,
} from "../../types/protocol";
import type { WsProtocolEvent } from "../../websocket/listen-client";

// ── Helpers ───────────────────────────────────────────────────────

const ENVELOPE = { session_id: "sess-1", uuid: "uuid-1" } as const;

// ── TranscriptBackfillMessage ─────────────────────────────────────

describe("TranscriptBackfillMessage", () => {
  test("minimal empty backfill is structurally valid", () => {
    const msg: TranscriptBackfillMessage = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: true,
    };
    expect(msg.type).toBe("transcript_backfill");
    expect(msg.messages).toHaveLength(0);
    expect(msg.is_final).toBe(true);
  });

  test("is_final: false marks a non-terminal chunk", () => {
    const msg: TranscriptBackfillMessage = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: false,
    };
    expect(msg.is_final).toBe(false);
  });

  test("type discriminant is 'transcript_backfill'", () => {
    const msg: TranscriptBackfillMessage = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: true,
    };
    // Narrowing works via the discriminant
    if (msg.type === "transcript_backfill") {
      expect(msg.is_final).toBeDefined();
    }
  });
});

// ── QueueSnapshotMessage ──────────────────────────────────────────

describe("QueueSnapshotMessage", () => {
  test("empty snapshot is valid", () => {
    const msg: QueueSnapshotMessage = {
      ...ENVELOPE,
      type: "queue_snapshot",
      items: [],
    };
    expect(msg.type).toBe("queue_snapshot");
    expect(msg.items).toHaveLength(0);
  });

  test("snapshot with items preserves order and fields", () => {
    const msg: QueueSnapshotMessage = {
      ...ENVELOPE,
      type: "queue_snapshot",
      items: [
        { item_id: "item-1", kind: "message", source: "user" },
        {
          item_id: "item-2",
          kind: "task_notification",
          source: "task_notification",
        },
      ],
    };
    expect(msg.items).toHaveLength(2);
    const [first, second] = msg.items;
    expect(first?.item_id).toBe("item-1");
    expect(first?.kind).toBe("message");
    expect(first?.source).toBe("user");
    expect(second?.kind).toBe("task_notification");
  });
});

// ── SyncCompleteMessage ───────────────────────────────────────────

describe("SyncCompleteMessage", () => {
  test("had_pending_turn: false for idle connect", () => {
    const msg: SyncCompleteMessage = {
      ...ENVELOPE,
      type: "sync_complete",
      had_pending_turn: false,
    };
    expect(msg.type).toBe("sync_complete");
    expect(msg.had_pending_turn).toBe(false);
  });

  test("had_pending_turn: true for mid-turn connect", () => {
    const msg: SyncCompleteMessage = {
      ...ENVELOPE,
      type: "sync_complete",
      had_pending_turn: true,
    };
    expect(msg.had_pending_turn).toBe(true);
  });
});

// ── TranscriptSupplementMessage ───────────────────────────────────

describe("TranscriptSupplementMessage", () => {
  test("empty supplement is valid", () => {
    const msg: TranscriptSupplementMessage = {
      ...ENVELOPE,
      type: "transcript_supplement",
      messages: [],
    };
    expect(msg.type).toBe("transcript_supplement");
    expect(msg.messages).toHaveLength(0);
  });

  test("distinct type discriminant from transcript_backfill", () => {
    const backfill: TranscriptBackfillMessage = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: true,
    };
    const supplement: TranscriptSupplementMessage = {
      ...ENVELOPE,
      type: "transcript_supplement",
      messages: [],
    };
    expect(backfill.type).not.toBe(supplement.type);
  });
});

// ── Union membership ──────────────────────────────────────────────

describe("WireMessage union membership", () => {
  test("TranscriptBackfillMessage is assignable to WireMessage", () => {
    const msg: WireMessage = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: true,
    };
    expect(msg.type).toBe("transcript_backfill");
  });

  test("QueueSnapshotMessage is assignable to WireMessage", () => {
    const msg: WireMessage = {
      ...ENVELOPE,
      type: "queue_snapshot",
      items: [],
    };
    expect(msg.type).toBe("queue_snapshot");
  });

  test("SyncCompleteMessage is assignable to WireMessage", () => {
    const msg: WireMessage = {
      ...ENVELOPE,
      type: "sync_complete",
      had_pending_turn: false,
    };
    expect(msg.type).toBe("sync_complete");
  });

  test("TranscriptSupplementMessage is assignable to WireMessage", () => {
    const msg: WireMessage = {
      ...ENVELOPE,
      type: "transcript_supplement",
      messages: [],
    };
    expect(msg.type).toBe("transcript_supplement");
  });
});

describe("WsProtocolEvent union membership", () => {
  test("TranscriptBackfillMessage is assignable to WsProtocolEvent", () => {
    const msg: WsProtocolEvent = {
      ...ENVELOPE,
      type: "transcript_backfill",
      messages: [],
      is_final: true,
    };
    expect(msg.type).toBe("transcript_backfill");
  });

  test("QueueSnapshotMessage is assignable to WsProtocolEvent", () => {
    const msg: WsProtocolEvent = {
      ...ENVELOPE,
      type: "queue_snapshot",
      items: [],
    };
    expect(msg.type).toBe("queue_snapshot");
  });

  test("SyncCompleteMessage is assignable to WsProtocolEvent", () => {
    const msg: WsProtocolEvent = {
      ...ENVELOPE,
      type: "sync_complete",
      had_pending_turn: false,
    };
    expect(msg.type).toBe("sync_complete");
  });

  test("TranscriptSupplementMessage is assignable to WsProtocolEvent", () => {
    const msg: WsProtocolEvent = {
      ...ENVELOPE,
      type: "transcript_supplement",
      messages: [],
    };
    expect(msg.type).toBe("transcript_supplement");
  });
});

// ── Discriminant exhaustiveness ───────────────────────────────────

describe("type discriminants are unique across all four types", () => {
  test("all four sync-phase discriminants are distinct", () => {
    const types = [
      "transcript_backfill",
      "queue_snapshot",
      "sync_complete",
      "transcript_supplement",
    ];
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  test("none conflict with existing WireMessage discriminants", () => {
    // Existing discriminants: system, message, stream_event, auto_approval,
    // error, retry, recovery, result, control_response, control_request,
    // queue_item_enqueued, queue_batch_dequeued, queue_blocked, queue_cleared,
    // queue_item_dropped
    const existing = new Set([
      "system",
      "message",
      "stream_event",
      "auto_approval",
      "error",
      "retry",
      "recovery",
      "result",
      "control_response",
      "control_request",
      "queue_item_enqueued",
      "queue_batch_dequeued",
      "queue_blocked",
      "queue_cleared",
      "queue_item_dropped",
    ]);
    for (const t of [
      "transcript_backfill",
      "queue_snapshot",
      "sync_complete",
      "transcript_supplement",
    ]) {
      expect(existing.has(t)).toBe(false);
    }
  });
});
