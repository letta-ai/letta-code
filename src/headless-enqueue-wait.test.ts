import { expect, test } from "bun:test";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationStatusEvent,
  EnqueueReceipt,
} from "@/backend/api/conversation-enqueue";
import { waitForEnqueuedReply } from "./headless-enqueue-wait";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  workflow_id: "wf-1",
  super_run_id: "sr-1",
};
function event(
  correlations: Record<string, string[]>,
): ConversationStatusEvent {
  return {
    type: "conversation_super_run_update",
    conversation_id: "conv-1",
    status: {
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
  };
}
function assistant(text: string, runId: string): Message {
  return {
    id: `msg-${runId}`,
    date: "2026-09-01T02:33:43Z",
    message_type: "assistant_message",
    content: [{ type: "text", text }],
    run_id: runId,
    seq_id: 10,
  };
}
const neverEnds: AsyncIterator<ConversationStatusEvent> = {
  next: () => new Promise(() => {}),
};
const base = {
  receipt,
  events: neverEnds,
  signal: new AbortController().signal,
  latestSuperRun: async () => null,
  pollMs: 1,
};

test("Skill and approval continuation followed by an answer belongs to the original send", async () => {
  let checks = 0;
  let reads = 0;
  const events: AsyncIterator<ConversationStatusEvent> = {
    next: async () => {
      if (reads++ === 0)
        return {
          done: false,
          value: event({
            "run-approval": ["cm-1"],
            "run-final": ["cm-1"],
            "run-next-human": ["cm-2"],
          }),
        };
      return new Promise(() => {});
    },
  };
  const reply = await waitForEnqueuedReply({
    ...base,
    events,
    firstEvent: event({ "run-approval": ["cm-1"] }),
    retrieveRun: async (id): Promise<Run> => {
      checks++;
      return {
        id,
        agent_id: "agent-1",
        status: "completed",
        stop_reason: id === "run-approval" ? "requires_approval" : "end_turn",
      };
    },
    listRunMessages: async (id) => {
      expect(id).toBe("run-final");
      return [
        {
          id: "skill",
          date: "2026-09-01T02:33:40Z",
          message_type: "user_message",
          content:
            '<skill_content name="acquiring-skills">instructions</skill_content>',
          run_id: id,
        },
        {
          id: "task",
          date: "2026-09-01T02:33:41Z",
          message_type: "user_message",
          content: "<task-notification>done</task-notification>",
          run_id: id,
        },
        assistant("the requested answer", id),
      ];
    },
  });
  expect(checks).toBe(2);
  expect(reply.text).toBe("the requested answer");
  expect(reply.runIds).toEqual(["run-approval", "run-final"]);
});

test("a real subsequent human turn cannot supply the earlier answer", async () => {
  const reply = await waitForEnqueuedReply({
    ...base,
    firstEvent: event({ "run-1": ["cm-1"], "run-2": ["cm-2"] }),
    retrieveRun: async (id) => {
      expect(id).toBe("run-1");
      return {
        id,
        agent_id: "agent-1",
        status: "completed",
        stop_reason: "end_turn",
      };
    },
    listRunMessages: async (id) => [assistant("first answer", id)],
  });
  expect(reply.text).toBe("first answer");
  expect(reply.runIds).toEqual(["run-1"]);
});

test.each(["failed", "cancelled"] as const)(
  "remote %s terminates informatively",
  async (status) => {
    await expect(
      waitForEnqueuedReply({
        ...base,
        firstEvent: event({ "run-1": ["cm-1"] }),
        retrieveRun: async () => ({ id: "run-1", agent_id: "agent-1", status }),
        listRunMessages: async () => [],
      }),
    ).rejects.toThrow(`run-1 ${status}`);
  },
);

test("idle without a message mapping is not completion", async () => {
  const controller = new AbortController();
  let reads = 0;
  await expect(
    waitForEnqueuedReply({
      ...base,
      signal: controller.signal,
      firstEvent: event({}),
      retrieveRun: async () => {
        throw new Error("must not guess a run");
      },
      listRunMessages: async () => [],
      latestSuperRun: async () => {
        if (++reads === 2) controller.abort(new Error("wait deadline"));
        return null;
      },
    }),
  ).rejects.toThrow("wait deadline");
});

test("delivery failure before any run is a failure, not an empty successful answer", async () => {
  await expect(
    waitForEnqueuedReply({
      ...base,
      firstEvent: event({}),
      retrieveRun: async () => ({ id: "run-unexpected", agent_id: "agent-1" }),
      listRunMessages: async () => [],
      latestSuperRun: async () => ({
        id: "sr-1",
        status: "CAN",
        cancelled_at: "now",
        errored_at: "now",
        completed_at: null,
      }),
    }),
  ).rejects.toThrow("failed before a run");
});

test("closed status stream does not resend or infer completion", async () => {
  await expect(
    waitForEnqueuedReply({
      ...base,
      firstEvent: event({}),
      events: { next: async () => ({ done: true, value: undefined }) },
      retrieveRun: async () => ({ id: "run-unexpected", agent_id: "agent-1" }),
      listRunMessages: async () => [],
    }),
  ).rejects.toThrow("connection closed");
});

test("completed run allows the final message to become visible on a later read", async () => {
  let reads = 0;
  const reply = await waitForEnqueuedReply({
    ...base,
    firstEvent: event({ "run-1": ["cm-1"] }),
    retrieveRun: async () => ({
      id: "run-1",
      agent_id: "agent-1",
      status: "completed",
      stop_reason: "end_turn",
    }),
    listRunMessages: async () =>
      ++reads === 1 ? [] : [assistant("visible now", "run-1")],
  });
  expect(reply.text).toBe("visible now");
  expect(reads).toBe(2);
});
