import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { sendMessageStream } from "../../agent/message";
import {
  __testSetBackend,
  APIBackend,
  type APIClient,
  type ConversationMessageCreateBody,
} from "../../backend";

/**
 * Header propagation contract: when `SendMessageStreamOptions.actingUserId`
 * is set, the SDK call must carry `X-Letta-Acting-User-Id` so cloud-api
 * can re-attribute credits to the actual sender on multi-user sandbox
 * runtimes. Self-hosted / single-user flows do not set this option and
 * must NOT emit the header.
 */
describe("sendMessageStream acting-user header propagation", () => {
  test("source declares the option and the header in the documented form", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../agent/message.ts", import.meta.url)),
      "utf-8",
    );
    // Option is part of the public type
    expect(source).toContain("actingUserId?: string;");
    // Header injection uses the documented name
    expect(source).toContain('"X-Letta-Acting-User-Id"');
    // Header is only set when the option is provided
    expect(source).toContain("opts.actingUserId");
  });

  test("emits X-Letta-Acting-User-Id when actingUserId is provided", async () => {
    const captured: Array<{
      conversationId: string;
      body: ConversationMessageCreateBody;
      headers?: Record<string, string>;
    }> = [];

    const createMessageStreamMock = mock(
      async (
        conversationId: string,
        body: unknown,
        options?: { headers?: Record<string, string> },
      ) => {
        captured.push({
          conversationId,
          body: body as ConversationMessageCreateBody,
          headers: options?.headers,
        });
        return {
          // Minimal AsyncIterable shape — we never consume it in this test.
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ value: undefined, done: true }),
            };
          },
        } as unknown as Awaited<ReturnType<typeof sendMessageStream>>;
      },
    );

    const fakeClient = {
      agents: {
        create: mock(async () => ({ id: "a" })),
        retrieve: mock(async () => ({ id: "a" })),
        update: mock(async () => ({ id: "a" })),
        messages: { list: mock(async () => ({ getPaginatedItems: () => [] })) },
      },
      conversations: {
        retrieve: mock(async () => ({ id: "c" })),
        create: mock(async () => ({ id: "c" })),
        update: mock(async () => ({ id: "c" })),
        recompile: mock(async () => ""),
        messages: {
          list: mock(async () => ({ getPaginatedItems: () => [] })),
          create: createMessageStreamMock,
          stream: mock(async () => ({})),
        },
        cancel: mock(async () => ({})),
      },
      messages: { retrieve: mock(async () => []) },
      models: { list: mock(async () => []) },
      runs: {
        retrieve: mock(async () => ({ id: "r" })),
        messages: { stream: mock(async () => ({})) },
      },
    } as unknown as APIClient;

    const backend = new APIBackend({ getClient: async () => fakeClient });
    __testSetBackend(backend);

    try {
      const messages: MessageCreate[] = [{ role: "user", content: "hi" }];
      await sendMessageStream(
        "default",
        messages,
        {
          agentId: "agent-1",
          streamTokens: false,
          background: true,
          // The bit we care about — verifies the listener can attribute
          // a sandbox turn to the actual sender on the cloud side.
          actingUserId: "user-acting",
          skipImageNormalization: true,
        },
        { maxRetries: 0 },
      );
    } finally {
      __testSetBackend(null);
    }

    expect(captured.length).toBeGreaterThan(0);
    const headers = captured[0]?.headers ?? {};
    expect(headers["X-Letta-Acting-User-Id"]).toBe("user-acting");
  });

  test("omits the header when actingUserId is not set", async () => {
    const captured: Array<{ headers?: Record<string, string> }> = [];

    const createMessageStreamMock = mock(
      async (
        _conversationId: string,
        _body: unknown,
        options?: { headers?: Record<string, string> },
      ) => {
        captured.push({ headers: options?.headers });
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ value: undefined, done: true }),
            };
          },
        } as unknown as Awaited<ReturnType<typeof sendMessageStream>>;
      },
    );

    const fakeClient = {
      agents: {
        create: mock(async () => ({ id: "a" })),
        retrieve: mock(async () => ({ id: "a" })),
        update: mock(async () => ({ id: "a" })),
        messages: { list: mock(async () => ({ getPaginatedItems: () => [] })) },
      },
      conversations: {
        retrieve: mock(async () => ({ id: "c" })),
        create: mock(async () => ({ id: "c" })),
        update: mock(async () => ({ id: "c" })),
        recompile: mock(async () => ""),
        messages: {
          list: mock(async () => ({ getPaginatedItems: () => [] })),
          create: createMessageStreamMock,
          stream: mock(async () => ({})),
        },
        cancel: mock(async () => ({})),
      },
      messages: { retrieve: mock(async () => []) },
      models: { list: mock(async () => []) },
      runs: {
        retrieve: mock(async () => ({ id: "r" })),
        messages: { stream: mock(async () => ({})) },
      },
    } as unknown as APIClient;

    const backend = new APIBackend({ getClient: async () => fakeClient });
    __testSetBackend(backend);

    try {
      await sendMessageStream(
        "default",
        [{ role: "user", content: "hi" }] as MessageCreate[],
        {
          agentId: "agent-1",
          streamTokens: false,
          background: true,
          skipImageNormalization: true,
        },
        { maxRetries: 0 },
      );
    } finally {
      __testSetBackend(null);
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.headers?.["X-Letta-Acting-User-Id"]).toBeUndefined();
  });
});
