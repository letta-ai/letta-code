import { expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { getInboundImageFailureModes } from "./image-policy";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

const image: MessageCreate["content"] = [
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
  },
];

test("only image-bearing queued inputs establish an image policy boundary", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const enqueue = (
    otid: string,
    imageFailureMode: "strict" | "drop",
    content: MessageCreate["content"],
  ) =>
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      imageFailureMode,
      messages: [{ role: "user", content, otid }],
    });

  enqueue("strict-text-before", "strict", "before");
  enqueue("drop-image", "drop", image);
  enqueue("strict-text-after", "strict", "after");
  enqueue("strict-image", "strict", image);
  enqueue("drop-text", "drop", "last");

  const first = consumeQueuedTurn(runtime);
  expect(first?.queuedTurn.messages.map((message) => message.otid)).toEqual([
    "strict-text-before",
    "drop-image",
    "strict-text-after",
  ]);
  expect(first && getInboundImageFailureModes(first.queuedTurn)).toEqual({
    "drop-image": "drop",
  });

  const second = consumeQueuedTurn(runtime);
  expect(second?.queuedTurn.messages.map((message) => message.otid)).toEqual([
    "strict-image",
    "drop-text",
  ]);
  expect(
    second && getInboundImageFailureModes(second.queuedTurn),
  ).toBeUndefined();
  expect(consumeQueuedTurn(runtime)).toBeNull();
});
