import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createAppServerClient } from "@/app-server-client";

function fakeServer() {
  const sent: Array<Record<string, unknown>> = [];
  class Socket extends EventEmitter {
    readyState = 1;
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    send(raw: string) {
      const command = JSON.parse(raw) as Record<string, unknown>;
      sent.push(command);
      if (command.type !== "conversation_delete") return;
      const emit = (message: object) =>
        this.emit("message", JSON.stringify(message));
      emit({
        type: "conversation_list_response",
        request_id: command.request_id,
        success: true,
        conversations: [],
      });
      emit({
        type: "conversation_delete_response",
        request_id: command.request_id,
        success: true,
        conversation_id: command.conversation_id,
      });
    }
  }
  const client = createAppServerClient({
    url: "ws://app-server.test",
    WebSocket: Socket as never,
    requestTimeoutMs: 1_000,
  });
  return { client, sent };
}

test("conversationDelete keeps a generated request_id and waits for its own response type", async () => {
  const { client, sent } = fakeServer();

  const response = await client.conversationDelete({
    conversation_id: "conv-1",
    request_id: undefined,
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "conversation_delete",
    conversation_id: "conv-1",
  });
  expect(typeof sent[0]?.request_id).toBe("string");
  expect((sent[0]?.request_id as string).length).toBeGreaterThan(0);
  expect(response).toEqual({
    type: "conversation_delete_response",
    request_id: sent[0]?.request_id as string,
    success: true,
    conversation_id: "conv-1",
  });
  client.close();
});
