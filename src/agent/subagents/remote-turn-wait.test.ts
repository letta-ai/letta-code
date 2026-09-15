import { expect, test } from "bun:test";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationStatusEvent,
  EnqueueReceipt,
  LatestConversationSuperRun,
} from "@/backend/api/conversation-enqueue";
import {
  EnqueuedWaitError,
  SendEndedWithoutReplyError,
} from "@/headless-enqueue-wait";
import {
  RemoteTurnAbortedError,
  type RemoteTurnWaitDeps,
  waitForRemoteTurnReply,
} from "./remote-turn-wait";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  workflow_id: "wf-1",
  super_run_id: "sr-1",
};

function snapshot(
  correlations: Record<string, string[]>,
): ConversationStatusEvent {
  return {
    type: "conversation_super_run_snapshot",
    statuses: [
      {
        conversation_id: "conv-1",
        active_super_runs: [],
        runtime_status: {
          state: "ACTIVE",
          loop_state: {
            status: "WAITING_ON_INPUT",
            client_message_ids_by_run_id: correlations,
          },
        },
      },
    ],
  };
}

/** A status stream that yields its events, then closes (or never ends). */
function stream(
  events: ConversationStatusEvent[],
  ending: "close" | "hang",
): AsyncIterable<ConversationStatusEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (index < events.length)
          return {
            done: false,
            value: events[index++] as ConversationStatusEvent,
          };
        if (ending === "close") return { done: true, value: undefined };
        return new Promise(() => {});
      },
    }),
  };
}

function assistant(text: string, runId: string): Message {
  return {
    id: `msg-${runId}`,
    date: "2026-09-15T03:00:00Z",
    message_type: "assistant_message",
    content: [{ type: "text", text }],
    run_id: runId,
    seq_id: 1,
  };
}

function deps(
  overrides: Partial<RemoteTurnWaitDeps> & {
    streams: Array<AsyncIterable<ConversationStatusEvent> | Error>;
  },
): RemoteTurnWaitDeps & { opened: number } {
  const state = { opened: 0 };
  const { streams, ...rest } = overrides;
  return {
    get opened() {
      return state.opened;
    },
    openStatusStream: async () => {
      const next = streams[state.opened++];
      if (!next) return stream([], "hang");
      if (next instanceof Error) throw next;
      return next;
    },
    retrieveRun: async (id) =>
      ({ id, status: "completed", stop_reason: "end_turn" }) as Run,
    listRunMessages: async (id) => [assistant(`reply from ${id}`, id)],
    latestSuperRun: async () => null,
    reconnectDelayMs: 1,
    maxReconnectDelayMs: 1,
    pollMs: 1,
    ...rest,
  };
}

test("a dropped status stream is reopened and run IDs seen before the drop survive it", async () => {
  // The first connection maps the run, then closes. The reconnect snapshot no
  // longer lists any correlation (the runtime went idle), so the reply must
  // be found through the run ID remembered from the first connection.
  let runReads = 0;
  const d = deps({
    streams: [
      stream([snapshot({ "run-1": ["cm-1"] })], "close"),
      stream([snapshot({})], "hang"),
    ],
    retrieveRun: async (id) => {
      runReads += 1;
      return {
        id,
        status: runReads < 3 ? "running" : "completed",
        stop_reason: runReads < 3 ? null : "end_turn",
      } as Run;
    },
  });
  const reply = await waitForRemoteTurnReply(
    { receipt, signal: new AbortController().signal },
    d,
  );
  expect(reply).toMatchObject({ text: "reply from run-1", runIds: ["run-1"] });
  expect(d.opened).toBe(2);
});

test("a failed subscription attempt is retried instead of ending the wait", async () => {
  const d = deps({
    streams: [
      new Error("HTTP 503"),
      stream([snapshot({ "run-1": ["cm-1"] })], "hang"),
    ],
  });
  const reply = await waitForRemoteTurnReply(
    { receipt, signal: new AbortController().signal },
    d,
  );
  expect(reply.text).toBe("reply from run-1");
  expect(d.opened).toBe(2);
});

test("Cloud reporting the run failed ends the wait without reconnecting", async () => {
  const d = deps({
    streams: [
      stream([snapshot({ "run-1": ["cm-1"] })], "hang"),
      stream([snapshot({ "run-1": ["cm-1"] })], "hang"),
    ],
    retrieveRun: async (id) =>
      ({ id, status: "failed", stop_reason: "error" }) as Run,
  });
  const error = await waitForRemoteTurnReply(
    { receipt, signal: new AbortController().signal },
    d,
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EnqueuedWaitError);
  expect((error as EnqueuedWaitError).cause).toBeInstanceOf(
    SendEndedWithoutReplyError,
  );
  expect((error as Error).message).toContain("run-1 failed");
  expect(d.opened).toBe(1);
});

test("a super run that completed before any run was observed ends the wait", async () => {
  let now = 0;
  const latest: LatestConversationSuperRun = {
    id: "sr-1",
    status: "COM",
    completed_at: "2026-09-15T03:00:00Z",
    cancelled_at: null,
    errored_at: null,
  };
  const d = deps({
    streams: [stream([snapshot({})], "hang")],
    latestSuperRun: async () => {
      now += 10_000;
      return latest;
    },
    now: () => now,
  });
  const error = await waitForRemoteTurnReply(
    { receipt, signal: new AbortController().signal },
    d,
  ).catch((e: unknown) => e);
  expect((error as EnqueuedWaitError).sendEnded).toBe(true);
  expect((error as Error).message).toContain(
    "completed before a run was observed",
  );
});

test("aborting stops the wait during a reconnect backoff", async () => {
  const controller = new AbortController();
  const d = deps({
    streams: [stream([snapshot({})], "close")],
    reconnectDelayMs: 60_000,
    maxReconnectDelayMs: 60_000,
  });
  const pending = waitForRemoteTurnReply(
    { receipt, signal: controller.signal },
    d,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RemoteTurnAbortedError);
});
