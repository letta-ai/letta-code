import { expect, test } from "bun:test";
import type { QueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

const scope = { agentId: "agent-1", conversationId: "conv-1" };

type QueueInput = {
  [Kind in QueueItem["kind"]]: Omit<
    Extract<QueueItem, { kind: Kind }>,
    "id" | "enqueuedAt"
  >;
}[QueueItem["kind"]];

const inputs = [
  { kind: "message", source: "user", content: "follow-up" },
  { kind: "task_notification", source: "task_notification", text: "completed" },
  {
    kind: "cron_prompt",
    source: "cron",
    text: "scheduled",
    cronTaskId: "cron-1",
  },
  { kind: "mod_continue", source: "system", text: "continue" },
] as const;

function setup() {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    scope.agentId,
    scope.conversationId,
  );
  function enqueue(input: QueueInput) {
    if (input.kind === "message") {
      enqueueInboundUserMessage(
        runtime,
        {
          type: "message",
          ...scope,
          noCoalesce: input.noCoalesce,
          messages: [
            {
              role: "user",
              content: input.content,
              client_message_id: `client-${runtime.queueRuntime.length}`,
            },
          ],
        },
        input.actingUserId,
      );
    } else {
      runtime.queueRuntime.enqueue({ ...scope, ...input });
    }
    const item = runtime.queueRuntime.peek().at(-1);
    if (!item) throw new Error("Expected an enqueued item");
    return item;
  }
  return { runtime, enqueue };
}

for (const blocker of inputs) {
  for (const eligible of inputs) {
    test(`${blocker.kind} from another sender cannot block ${eligible.kind}`, () => {
      const { runtime, enqueue } = setup();
      const first = enqueue({ ...blocker, actingUserId: "user-b" });
      const matching = enqueue({ ...eligible, actingUserId: "user-a" });
      const later = enqueue({ ...blocker, actingUserId: "user-b" });
      const batch = consumeQueuedTurn(runtime, { actingUserId: "user-a" });
      expect(batch?.dequeuedBatch.items).toEqual([matching]);
      expect(batch?.dequeuedBatch.queueLenAfter).toBe(2);
      expect(batch?.queuedTurn.actingUserId).toBe("user-a");
      expect(runtime.queueRuntime.peek()).toEqual([first, later]);
      // Items left for their own turn keep their original order and identity.
      const next = consumeQueuedTurn(runtime);
      expect(next?.dequeuedBatch.items).toEqual([first, later]);
      expect(next?.queuedTurn.actingUserId).toBe("user-b");
      expect(runtime.queueRuntime.length).toBe(0);
      expect(runtime.queuedMessagesByItemId.size).toBe(0);
    });
  }
}

for (const kind of ["approval_result", "overlay_action"] as const) {
  test(`sender skipping does not cross ${kind}`, () => {
    const { runtime, enqueue } = setup();
    enqueue({ ...inputs[0], actingUserId: "user-b" });
    enqueue({
      kind,
      source: "system",
      text: "barrier",
      actingUserId: "user-b",
    });
    enqueue({ ...inputs[1], actingUserId: "user-a" });
    expect(consumeQueuedTurn(runtime, { actingUserId: "user-a" })).toBeNull();
    expect(runtime.queueRuntime.length).toBe(3);
  });
}

test("sender skipping does not cross a conversation boundary", () => {
  const { runtime, enqueue } = setup();
  enqueue({ ...inputs[1], actingUserId: "user-b" });
  enqueue({
    ...inputs[1],
    conversationId: "conv-other",
    actingUserId: "user-b",
  });
  enqueue({ ...inputs[1], actingUserId: "user-a" });
  expect(consumeQueuedTurn(runtime, { actingUserId: "user-a" })).toBeNull();
  expect(runtime.queueRuntime.length).toBe(3);
});

test("eligible paused messages stay parked while notifications pass", () => {
  const { runtime, enqueue } = setup();
  const other = enqueue({ ...inputs[1], actingUserId: "user-b" });
  const paused = enqueue({ ...inputs[0], actingUserId: "user-a" });
  runtime.queueRuntime.pause();
  const notification = enqueue({ ...inputs[1], actingUserId: "user-a" });
  const batch = consumeQueuedTurn(runtime, { actingUserId: "user-a" });
  expect(batch?.dequeuedBatch.items).toEqual([notification]);
  expect(runtime.queueRuntime.peek()).toEqual([other, paused]);
  expect(paused.paused).toBe(true);
});

test("a selected noCoalesce message still consumes only its own batch", () => {
  const { runtime, enqueue } = setup();
  const other = enqueue({ ...inputs[0], actingUserId: "user-b" });
  const single = enqueue({
    ...inputs[0],
    noCoalesce: true,
    actingUserId: "user-a",
  });
  const later = enqueue({ ...inputs[1], actingUserId: "user-a" });
  expect(
    consumeQueuedTurn(runtime, { actingUserId: "user-a" })?.dequeuedBatch.items,
  ).toEqual([single]);
  expect(runtime.queueRuntime.peek()).toEqual([other, later]);
  expect(
    consumeQueuedTurn(runtime, { actingUserId: "user-a" })?.dequeuedBatch.items,
  ).toEqual([later]);
  expect(runtime.queueRuntime.peek()).toEqual([other]);
});
