import { expect, test } from "bun:test";
import {
  dequeueConversationMessage,
  enqueueConversationMessage,
} from "./conversation-enqueue";
import { ApiRequestError, type apiRequest } from "./request";

test("enqueue carries the existing trusted acting-user HTTP header", async () => {
  const request: typeof apiRequest = async <T>(
    _method: string,
    _path: string,
    _body?: Record<string, unknown>,
    options = {},
  ) => {
    expect(options).toMatchObject({
      headers: { "X-Letta-Acting-User-Id": "user-parent" },
    });
    return {
      client_message_id: "cm",
      workflow_id: "wf",
      super_run_id: "sr",
    } as T;
  };
  await enqueueConversationMessage(
    {
      agentId: "agent",
      conversationId: "conv",
      clientMessageId: "cm",
      content: "hello",
      actingUserId: "user-parent",
    },
    undefined,
    request,
  );
});

test.each(["default", "conv-1"])(
  "dequeue addresses the original accepted message: %s",
  async (conversationId) => {
    const request: typeof apiRequest = async <T>(
      method: string,
      path: string,
      body?: Record<string, unknown>,
      options = {},
    ) => {
      expect(method).toBe("DELETE");
      expect(path).toBe(
        `/v1/conversations/${conversationId}/messages/enqueue/cm-1`,
      );
      expect(body).toBeUndefined();
      expect(options).toEqual({
        signal: undefined,
        ...(conversationId === "default"
          ? { query: { agent_id: "agent-1" } }
          : {}),
      });
      return { client_message_id: "cm-1", status: "dequeued" } as T;
    };
    expect(
      await dequeueConversationMessage(
        { agentId: "agent-1", conversationId, clientMessageId: "cm-1" },
        undefined,
        request,
      ),
    ).toMatchObject({ status: "dequeued" });
  },
);

test.each([undefined, "My laptop", "cloud"])(
  "enqueue passes the selector and stable message ID: %s",
  async (computer) => {
    let body: Record<string, unknown> | undefined;
    const request: typeof apiRequest = async <T>(
      method: string,
      path: string,
      value?: Record<string, unknown>,
    ) => {
      expect(method).toBe("POST");
      expect(path).toBe("/v1/conversations/conv-target/messages/enqueue");
      body = value;
      return {
        client_message_id: "cm-1",
        workflow_id: "wf-1",
        super_run_id: "sr-1",
      } as T;
    };
    const receipt = await enqueueConversationMessage(
      {
        agentId: "agent-target",
        conversationId: "conv-target",
        clientMessageId: "cm-1",
        content: "hello",
        computer,
      },
      undefined,
      request,
    );
    expect(body?.computer).toBe(computer);
    expect(body?.messages).toEqual([
      { role: "user", content: "hello", client_message_id: "cm-1" },
    ]);
    expect(receipt).toEqual({
      status: "queued",
      agent_id: "agent-target",
      conversation_id: "conv-target",
      client_message_id: "cm-1",
      workflow_id: "wf-1",
      super_run_id: "sr-1",
    });
    expect(receipt).not.toHaveProperty("run_id");
  },
);

test.each([400, 404, 409, 503])(
  "HTTP %s never falls back to local execution or retries",
  async (status) => {
    let calls = 0;
    const request: typeof apiRequest = async () => {
      calls++;
      throw new ApiRequestError("rejected", status, "");
    };
    await expect(
      enqueueConversationMessage(
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          clientMessageId: "cm-1",
          content: "hello",
        },
        undefined,
        request,
      ),
    ).rejects.toMatchObject({ status });
    expect(calls).toBe(1);
  },
);

test("a mismatched receipt does not confirm the requested send", async () => {
  const request: typeof apiRequest = async <T>() =>
    ({
      client_message_id: "another-send",
      workflow_id: "wf",
      super_run_id: "sr",
    }) as T;
  await expect(
    enqueueConversationMessage(
      {
        agentId: "agent-1",
        conversationId: "conv-1",
        clientMessageId: "cm-1",
        content: "hi",
      },
      undefined,
      request,
    ),
  ).rejects.toThrow("acceptance is unknown");
});
