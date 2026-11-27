import { describe, expect, test } from "bun:test";
import type {
  CanUseToolCallback,
  CanUseToolResponse,
  SDKMessage,
  SessionDeviceStatus,
} from "@letta-ai/letta-agent-sdk/client";
import {
  createTuiSessionStore,
  type TuiSession,
  type TuiSessionStore,
} from "./session-store";

type HistoryMessage = Awaited<
  ReturnType<TuiSession["listMessages"]>
>["messages"][number];

function deviceStatus(
  overrides: Partial<SessionDeviceStatus> = {},
): SessionDeviceStatus {
  return {
    isOnline: true,
    isProcessing: false,
    permissionMode: "standard",
    workingDirectory: "/work",
    memoryDirectory: null,
    pendingControlRequests: [],
    raw: {},
    ...overrides,
  };
}

class FakeSession implements TuiSession {
  history: HistoryMessage[] = [];
  sent: Array<{ text: string; otid?: string }> = [];
  aborts = 0;
  removed: string[] = [];
  recovered = 0;
  status = deviceStatus();
  canUseTool: CanUseToolCallback | null = null;
  private pending: SDKMessage[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  emit(...messages: SDKMessage[]): void {
    this.pending.push(...messages);
    this.waiter?.();
  }

  async ready() {
    return { agentId: "agent-1", conversationId: "conv-1", model: "model-1" };
  }

  async send(message: unknown, options?: { otid?: string }) {
    this.sent.push({ text: String(message), otid: options?.otid });
  }

  async *stream(): AsyncGenerator<SDKMessage> {
    while (!this.ended) {
      const next = this.pending.shift();
      if (!next) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        this.waiter = null;
        continue;
      }
      yield next;
      if (next.type === "result") return;
    }
  }

  async abort() {
    this.aborts += 1;
  }

  async listMessages() {
    return { messages: [...this.history].reverse() };
  }

  async recoverPendingApprovals() {
    this.recovered += 1;
    return { recovered: true, unsupported: false };
  }

  async changeDeviceState() {}

  async removeQueuedMessage(itemId: string) {
    this.removed.push(itemId);
    return { itemId, removed: true };
  }

  async getDeviceStatus() {
    return this.status;
  }

  onDeviceStatus() {
    return () => {};
  }

  close() {
    this.ended = true;
    this.waiter?.();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function startStore(session: FakeSession): Promise<TuiSessionStore> {
  let counter = 0;
  const store = createTuiSessionStore({
    openSession: (canUseTool) => {
      session.canUseTool = canUseTool;
      return session;
    },
    flushMs: 1,
    createId: (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  });
  await store.start();
  await settle();
  return store;
}

function userHistory(id: string, otid: string, text: string): HistoryMessage {
  return {
    id,
    otid,
    message_type: "user_message",
    content: text,
    date: "2026-01-01T00:00:00.000Z",
  } as HistoryMessage;
}

function assistantHistory(
  id: string,
  text: string,
  seqId: number,
): HistoryMessage {
  return {
    id,
    message_type: "assistant_message",
    content: text,
    run_id: "run-1",
    seq_id: seqId,
    date: "2026-01-01T00:00:01.000Z",
  } as HistoryMessage;
}

function assistant(uuid: string, content: string, seqId: number): SDKMessage {
  return {
    type: "assistant",
    content,
    uuid,
    runId: "run-1",
    seqId,
  } as SDKMessage;
}

function loopStatus(status: string): SDKMessage {
  return { type: "loop_status", status, activeRunIds: [] };
}

function result(stopReason = "end_turn", success = true): SDKMessage {
  return {
    type: "result",
    success,
    stopReason,
    durationMs: 1,
    conversationId: "conv-1",
  } as SDKMessage;
}

function texts(store: TuiSessionStore): string[] {
  return store
    .getSnapshot()
    .items.map((item) =>
      "text" in item ? `${item.kind}:${item.text}` : item.kind,
    );
}

describe("TUI session store", () => {
  test("drops replayed stream positions for a run", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    session.emit(assistant("msg-1", "hello", 1));
    session.emit(assistant("msg-1", "hello", 1));
    await settle();
    expect(texts(store)).toEqual(["assistant:hello"]);
    store.close();
  });

  test("retires the local echo by otid without moving it", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    await store.send("hi");
    const otid = session.sent[0]?.otid;
    expect(otid).toBeDefined();
    expect(store.getSnapshot().items).toEqual([
      {
        kind: "user",
        id: otid as string,
        text: "hi",
        otid,
        pending: undefined,
      },
    ]);
    session.emit({
      type: "stream_event",
      uuid: "user-1",
      event: {
        type: "message",
        id: "user-1",
        message_type: "user_message",
        content: "hi",
        otid,
      },
    } as SDKMessage);
    session.emit(assistant("msg-1", "pong", 1), result());
    await settle();
    expect(texts(store)).toEqual(["user:hi", "assistant:pong"]);
    const before = store.getSnapshot();

    session.history = [
      userHistory("user-1", otid as string, "hi"),
      assistantHistory("msg-1", "pong", 1),
    ];
    await store.reconnect();
    const after = store.getSnapshot();
    expect(texts(store)).toEqual(["user:hi", "assistant:pong"]);
    expect(after.items.map((item) => item.id)).toEqual(
      before.items.map((item) => item.id),
    );
    expect(after.epoch).toBe(before.epoch);
    expect(after.connection).toBe("connected");
    expect(session.recovered).toBe(1);
    store.close();
  });

  test("merges a mid-run history page without duplicating live rows", async () => {
    const session = new FakeSession();
    session.history = [
      userHistory("user-0", "otid-0", "earlier"),
      assistantHistory("msg-0", "earlier reply", 1),
    ];
    const store = await startStore(session);
    expect(texts(store)).toEqual(["user:earlier", "assistant:earlier reply"]);
    expect(store.getSnapshot().committedCount).toBe(2);

    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    session.emit({
      type: "assistant",
      content: "live",
      uuid: "msg-2",
      runId: "run-2",
      seqId: 1,
    } as SDKMessage);
    await settle();
    expect(store.getSnapshot().run).toBe("running");
    expect(store.getSnapshot().committedCount).toBe(2);

    await store.reconnect();
    expect(texts(store)).toEqual([
      "user:earlier",
      "assistant:earlier reply",
      "assistant:live",
    ]);
    expect(store.getSnapshot().epoch).toBe(0);
    store.close();
  });

  test("bumps the epoch when history lands ahead of committed rows", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    session.emit(assistant("msg-9", "late", 5), result());
    await settle();
    expect(store.getSnapshot().committedCount).toBe(1);

    session.history = [
      userHistory("user-0", "otid-0", "earlier"),
      assistantHistory("msg-9", "late", 5),
    ];
    await store.reconnect();
    expect(texts(store)).toEqual(["user:earlier", "assistant:late"]);
    expect(store.getSnapshot().epoch).toBe(1);
    expect(store.getSnapshot().committedCount).toBe(2);
    store.close();
  });

  test("routes approval decisions back to the runtime", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    const ask = (requestId: string) =>
      Promise.resolve(
        session.canUseTool?.(
          "Bash",
          { command: "ls" },
          {
            requestId,
            toolCallId: `tool-${requestId}`,
            permissionSuggestions: [{ id: "rule-1", text: "Allow ls" }],
          },
        ),
      ) as Promise<CanUseToolResponse>;

    const allowed = ask("req-1");
    expect(store.getSnapshot().run).toBe("awaiting_approval");
    expect(store.getSnapshot().approvals[0]).toMatchObject({
      requestId: "req-1",
      toolCallId: "tool-req-1",
      toolName: "Bash",
      toolArgs: '{"command":"ls"}',
    });
    store.resolveApproval("req-1", { kind: "allow" });
    expect(await allowed).toEqual({ behavior: "allow" });
    expect(store.getSnapshot().run).toBe("running");

    const always = ask("req-2");
    store.resolveApproval("req-2", { kind: "allow_always" });
    expect(await always).toEqual({
      behavior: "allow",
      updatedPermissions: [{ id: "rule-1", text: "Allow ls" }],
    });

    const denied = ask("req-3");
    store.resolveApproval("req-3", { kind: "deny", reason: "no" });
    expect(await denied).toEqual({ behavior: "deny", message: "no" });
    expect(store.getSnapshot().approvals).toEqual([]);
    store.close();
  });

  test("interrupt aborts, releases approvals, and settles on the result", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    await settle();
    const pending = Promise.resolve(
      session.canUseTool?.("Bash", { command: "sleep 9" }, { requestId: "r" }),
    );
    await store.interrupt();
    expect(session.aborts).toBe(1);
    expect(await pending).toEqual({ behavior: "deny", message: "Interrupted" });
    expect(store.getSnapshot().run).toBe("interrupting");

    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    await settle();
    expect(store.getSnapshot().run).toBe("interrupting");

    session.emit(result("interrupted", false));
    await settle();
    expect(store.getSnapshot().run).toBe("idle");
    expect(store.getSnapshot().items.at(-1)).toMatchObject({
      kind: "status",
      lines: ["Interrupted"],
    });
    store.close();
  });

  test("shows server queue state for sends during a run", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    await settle();
    await store.send("follow up");
    expect(store.getSnapshot().items).toEqual([]);
    const otid = session.sent[0]?.otid as string;

    session.emit({
      type: "queue_update",
      queue: [
        {
          id: "q-1",
          clientMessageId: otid,
          kind: "message",
          source: "user",
          content: "follow up",
          enqueuedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await settle();
    expect(store.getSnapshot().queue).toEqual([
      { id: "q-1", text: "follow up" },
    ]);

    await store.removeQueued("q-1");
    expect(session.removed).toEqual(["q-1"]);
    expect(store.getSnapshot().queue[0]?.pendingRemoval).toBe(true);

    session.emit({ type: "queue_update", queue: [] });
    await settle();
    expect(store.getSnapshot().queue).toEqual([]);
    store.close();
  });

  test("shows a dequeued message when the runtime starts it", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    await settle();
    await store.send("follow up");
    const otid = session.sent[0]?.otid as string;
    session.emit({
      type: "stream_event",
      uuid: "user-2",
      event: {
        type: "message",
        id: "user-2",
        message_type: "user_message",
        content: "follow up",
        otid,
      },
    } as SDKMessage);
    await settle();
    expect(texts(store)).toEqual(["user:follow up"]);
    store.close();
  });

  test("reconciles a stale running phase with device status", async () => {
    const session = new FakeSession();
    const store = await startStore(session);
    session.emit(loopStatus("PROCESSING_API_RESPONSE"));
    await settle();
    expect(store.getSnapshot().run).toBe("running");
    session.status = deviceStatus({ isProcessing: false });
    await store.reconnect();
    expect(store.getSnapshot().run).toBe("idle");
    expect(store.getSnapshot().device).toEqual({
      permissionMode: "standard",
      cwd: "/work",
      memoryDirectory: null,
    });
    store.close();
  });
});
