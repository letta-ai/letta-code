import { expect, test } from "bun:test";
import {
  dequeueConversationMessage,
  enqueueConversationMessage,
} from "./conversation-enqueue";
import { ApiRequestError, apiRequest } from "./request";

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

test("retries only a typed pre-admission shutdown rejection with the same message ID", async () => {
  const requests: Array<{
    body: Record<string, unknown>;
    actingUser: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        actingUser: request.headers.get("X-Letta-Acting-User-Id"),
      });
      if (requests.length === 1) {
        return Response.json(
          {
            error:
              "Service temporarily unavailable. Please retry your request.",
            errorCode: "cloud_api_shutting_down",
            admitted: false,
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "0" } },
        );
      }
      return Response.json(
        {
          client_message_id: requests[0]?.body.client_message_id,
          workflow_id: "wf-1",
          super_run_id: "sr-1",
        },
        { status: 202 },
      );
    },
  });
  const request: typeof apiRequest = (method, path, body, options = {}) =>
    apiRequest(method, path, body, {
      ...options,
      baseUrl: server.url.toString().replace(/\/$/, ""),
      apiKey: "test-only",
    });
  try {
    const receipt = await enqueueConversationMessage(
      {
        agentId: "agent-target",
        conversationId: "conv-target",
        clientMessageId: "cm-stable",
        content: "hello",
        actingUserId: "user-parent",
      },
      undefined,
      request,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.body.client_message_id).toBe("cm-stable");
    expect(requests[0]?.actingUser).toBe("user-parent");
    expect(receipt).toMatchObject({
      status: "queued",
      client_message_id: "cm-stable",
      workflow_id: "wf-1",
      super_run_id: "sr-1",
    });
  } finally {
    server.stop(true);
  }
});

test.each([
  { admitted: true, retryable: true, errorCode: "cloud_api_shutting_down" },
  { admitted: false, retryable: false, errorCode: "cloud_api_shutting_down" },
  { admitted: false, retryable: true, errorCode: "other_error" },
])("does not retry a 503 without proven rejection: %j", async (payload) => {
  let calls = 0;
  const request: typeof apiRequest = async () => {
    calls++;
    throw new ApiRequestError("rejected", 503, JSON.stringify(payload));
  };
  await expect(
    enqueueConversationMessage(
      {
        agentId: "agent-target",
        conversationId: "conv-target",
        clientMessageId: "cm-stable",
        content: "hello",
      },
      undefined,
      request,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(calls).toBe(1);
});

test("cancels a shutdown retry without resending", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let calls = 0;
  const request: typeof apiRequest = async () => {
    calls++;
    throw new ApiRequestError(
      "rejected",
      503,
      JSON.stringify({
        errorCode: "cloud_api_shutting_down",
        admitted: false,
        retryable: true,
      }),
      new Headers({ "Retry-After": "3" }),
    );
  };
  const pending = enqueueConversationMessage(
    {
      agentId: "agent-target",
      conversationId: "conv-target",
      clientMessageId: "cm-stable",
      content: "hello",
    },
    controller.signal,
    request,
  );
  await Promise.resolve();
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test("stops after three typed pre-admission retries", async () => {
  let calls = 0;
  const rejection = new ApiRequestError(
    "rejected",
    503,
    JSON.stringify({
      errorCode: "cloud_api_shutting_down",
      admitted: false,
      retryable: true,
    }),
    new Headers({ "Retry-After": "0" }),
  );
  const request: typeof apiRequest = async () => {
    calls++;
    throw rejection;
  };
  await expect(
    enqueueConversationMessage(
      {
        agentId: "agent-target",
        conversationId: "conv-target",
        clientMessageId: "cm-stable",
        content: "hello",
      },
      undefined,
      request,
    ),
  ).rejects.toBe(rejection);
  expect(calls).toBe(4);
});

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
