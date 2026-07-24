import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  enqueueOutboundFrame,
  getOutboundQueueStats,
  OUTBOUND_QUEUE_LIMITS,
  type OutboundFrame,
  type OutboundFrameClass,
} from "@/websocket/listener/outbound-wire";
import type { ListenerTransport } from "@/websocket/listener/transport";

/** Local-kind fake: settable buffer, records sends. */
function makeLocalTransport(options?: { bufferedAmount?: number }) {
  const sent: string[] = [];
  const transport = {
    kind: "local" as const,
    bufferedAmount: options?.bufferedAmount ?? 0,
    isOpen: () => true,
    send: (data: string) => {
      sent.push(data);
    },
  };
  return { transport: transport as ListenerTransport, sent, raw: transport };
}

/** WebSocket-kind fake (no `kind` field): supports terminate for kill tests. */
function makeWsTransport(options?: { bufferedAmount?: number }) {
  const sent: string[] = [];
  let terminated = false;
  const transport = {
    readyState: WebSocket.OPEN,
    bufferedAmount: options?.bufferedAmount ?? 0,
    send: (data: string) => {
      sent.push(data);
    },
    terminate: () => {
      terminated = true;
    },
  };
  return {
    transport: transport as unknown as ListenerTransport,
    sent,
    raw: transport,
    wasTerminated: () => terminated,
  };
}

function frame(
  label: string,
  frameClass: OutboundFrameClass,
  options?: Partial<OutboundFrame>,
): OutboundFrame {
  return {
    typeLabel: label,
    frameClass,
    build: () => ({ payload: label, perfKey: label }),
    ...options,
  };
}

describe("outbound wire queue", () => {
  test("sends synchronously in order while the socket is healthy", () => {
    const { transport, sent } = makeLocalTransport();

    enqueueOutboundFrame(transport, frame("a", "critical"));
    enqueueOutboundFrame(transport, frame("b", "delta"));
    enqueueOutboundFrame(transport, frame("c", "status"));

    expect(sent).toEqual(["a", "b", "c"]);
    expect(getOutboundQueueStats(transport).queuedFrames).toBe(0);
  });

  test("build runs at drain time and a null build skips the frame", () => {
    const { transport, sent } = makeLocalTransport();
    let built = 0;

    enqueueOutboundFrame(transport, {
      typeLabel: "skipped",
      frameClass: "critical",
      build: () => {
        built += 1;
        return null;
      },
    });
    enqueueOutboundFrame(transport, frame("kept", "critical"));

    expect(built).toBe(1);
    expect(sent).toEqual(["kept"]);
  });

  test("pauses above the high watermark and resumes via the drain poll", async () => {
    const { transport, sent, raw } = makeLocalTransport({
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES,
    });

    enqueueOutboundFrame(transport, frame("queued", "delta"));
    expect(sent).toEqual([]);
    expect(getOutboundQueueStats(transport).queuedFrames).toBe(1);

    raw.bufferedAmount = 0;
    await new Promise((resolve) =>
      setTimeout(resolve, OUTBOUND_QUEUE_LIMITS.DRAIN_POLL_MS + 20),
    );
    expect(sent).toEqual(["queued"]);
    expect(getOutboundQueueStats(transport).queuedFrames).toBe(0);
  });

  test("coalesces status frames latest-wins per key while queued", async () => {
    const { transport, sent, raw } = makeLocalTransport({
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES,
    });

    enqueueOutboundFrame(transport, {
      ...frame("loop:v1", "status"),
      coalesceKey: "update_loop_status:agent:conv",
    });
    enqueueOutboundFrame(transport, frame("delta:1", "delta"));
    enqueueOutboundFrame(transport, {
      ...frame("loop:v2", "status"),
      coalesceKey: "update_loop_status:agent:conv",
    });
    enqueueOutboundFrame(transport, {
      ...frame("device:v1", "status"),
      coalesceKey: "update_device_status:agent:conv",
    });

    expect(getOutboundQueueStats(transport).queuedFrames).toBe(3);

    raw.bufferedAmount = 0;
    await new Promise((resolve) =>
      setTimeout(resolve, OUTBOUND_QUEUE_LIMITS.DRAIN_POLL_MS + 20),
    );
    // v2 replaced v1 in place (order preserved), other keys untouched.
    expect(sent).toEqual(["loop:v2", "delta:1", "device:v1"]);
  });

  test("drops oldest delta frames first when the queue overflows", async () => {
    const { transport, sent, raw } = makeLocalTransport({
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES,
    });

    enqueueOutboundFrame(transport, frame("critical:1", "critical"));
    for (let i = 0; i < OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES; i += 1) {
      enqueueOutboundFrame(transport, frame(`delta:${i}`, "delta"));
    }

    const stats = getOutboundQueueStats(transport);
    expect(stats.queuedFrames).toBe(OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES);
    expect(stats.droppedDelta).toBe(1);
    expect(stats.killed).toBe(false);

    raw.bufferedAmount = 0;
    await new Promise((resolve) =>
      setTimeout(resolve, OUTBOUND_QUEUE_LIMITS.DRAIN_POLL_MS + 20),
    );
    // The critical frame survived; the oldest delta (delta:0) was shed.
    expect(sent[0]).toBe("critical:1");
    expect(sent).not.toContain("delta:0");
    expect(sent).toContain("delta:1");
  });

  test("terminates a websocket transport stalled past the kill threshold", () => {
    const { transport, wasTerminated } = makeWsTransport({
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.KILL_THRESHOLD_BUFFERED_BYTES,
    });

    enqueueOutboundFrame(transport, frame("doomed", "critical"));

    expect(wasTerminated()).toBe(true);
    const stats = getOutboundQueueStats(transport);
    expect(stats.killed).toBe(true);
    expect(stats.queuedFrames).toBe(0);
  });

  test("terminates when the queue overflows with only critical frames", () => {
    const { transport, wasTerminated } = makeWsTransport({
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES,
    });

    for (let i = 0; i <= OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES; i += 1) {
      enqueueOutboundFrame(transport, frame(`critical:${i}`, "critical"));
    }

    expect(wasTerminated()).toBe(true);
    expect(getOutboundQueueStats(transport).killed).toBe(true);
  });

  test("clears the backlog when the transport closes", async () => {
    let open = true;
    const sent: string[] = [];
    const transport = {
      kind: "local" as const,
      bufferedAmount: OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES,
      isOpen: () => open,
      send: (data: string) => {
        sent.push(data);
      },
    } as ListenerTransport;

    enqueueOutboundFrame(transport, frame("stranded", "delta"));
    expect(getOutboundQueueStats(transport).queuedFrames).toBe(1);

    open = false;
    await new Promise((resolve) =>
      setTimeout(resolve, OUTBOUND_QUEUE_LIMITS.DRAIN_POLL_MS + 20),
    );
    expect(sent).toEqual([]);
    expect(getOutboundQueueStats(transport).queuedFrames).toBe(0);
  });

  test("a throwing send reports the error and continues with later frames", () => {
    const sent: string[] = [];
    let sendErrors = 0;
    const transport = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: (data: string) => {
        if (data === "boom") throw new Error("send failed");
        sent.push(data);
      },
    } as ListenerTransport;

    enqueueOutboundFrame(transport, {
      ...frame("boom", "critical"),
      onSendError: () => {
        sendErrors += 1;
      },
    });
    enqueueOutboundFrame(transport, frame("after", "critical"));

    expect(sendErrors).toBe(1);
    expect(sent).toEqual(["after"]);
  });
});
