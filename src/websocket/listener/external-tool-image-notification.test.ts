import { expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";
import { normalizeExternalToolResultContent } from "@/tools/external-tool-content";
import { clearPendingMessages } from "@/utils/message-queue-bridge";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import type { IncomingMessage } from "./types";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";

test("a slow external image reaches the original listener completion turn", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  let turn: IncomingMessage | undefined;
  installProcessEventRouting({
    runtime: listener,
    processTransport: new LocalListenerTransport(),
    opts: {
      connectionId: "image-connection",
      wsUrl: "ws://test",
      deviceId: "device-image",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    },
    processQueuedTurn: async (incoming) => {
      turn = incoming;
    },
  });

  try {
    let complete!: (value: {
      status: "success";
      toolReturn: MessageCreate["content"];
    }) => void;
    const operation = new Promise<{
      status: "success";
      toolReturn: MessageCreate["content"];
    }>((resolve) => {
      complete = resolve;
    });
    const handle = await autoBackgroundExternalTool(
      "fetch_file",
      { autoBackground: true },
      operation,
      {
        yieldMs: 10,
        runtimeScope: {
          agentId: "agent-image",
          conversationId: "conv-image",
          actingUserId: "human-image",
        },
      },
    );
    expect(handle.toolReturn).toContain("is still running");

    const result = normalizeExternalToolResultContent([
      { type: "text", text: "image attached" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ]);
    if (typeof result === "string") throw new Error("Expected image content");
    complete({ status: "success", toolReturn: result });
    const deadline = Date.now() + 5_000;
    while (!turn && Date.now() < deadline) await Bun.sleep(10);
    if (!turn) throw new Error("No completion turn arrived");

    expect(turn).toMatchObject({
      agentId: "agent-image",
      conversationId: "conv-image",
      actingUserId: "human-image",
    });
    const message = turn.messages[0];
    if (!message || !("content" in message)) {
      throw new Error("Expected a queued user message");
    }
    const parts = message.content;
    if (!Array.isArray(parts)) throw new Error("Expected multimodal content");
    expect(parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<task-notification>"),
    });
    expect(parts.slice(2)).toEqual(result);

    let sent: MessageCreateParams | undefined;
    const backend = {
      createConversationMessageStream: async (
        _id: string,
        body: MessageCreateParams,
      ) => {
        sent = body;
        return {
          async *[Symbol.asyncIterator]() {},
        } as unknown as Stream<LettaStreamingResponse>;
      },
    } as unknown as Parameters<typeof sendMessageStreamWithBackend>[0];
    await sendMessageStreamWithBackend(backend, "conv-image", turn.messages, {
      streamTokens: true,
      background: true,
      preparedToolContext: {
        contextId: "image-notification",
        clientTools: [],
        loadedToolNames: [],
      },
    });
    const sentMessage = sent?.messages?.[0];
    if (!sentMessage || !("content" in sentMessage)) {
      throw new Error("Expected a model request with the image notification");
    }
    expect(sentMessage.content).toEqual(parts);
  } finally {
    clearProcessServices(listener);
    clearPendingMessages();
    setActiveRuntime(null);
  }
}, 10_000);
