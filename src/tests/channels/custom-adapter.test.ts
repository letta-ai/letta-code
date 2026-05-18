import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCustomAdapter } from "../../channels/custom/adapter";
import type { CustomChannelAccount } from "../../channels/types";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeAccount(
  config: Record<string, unknown> = {},
): CustomChannelAccount {
  return {
    channel: "custom",
    accountId: "acct-1",
    displayName: "My Custom App",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: {
      url: "https://example.com/webhook",
      bot_token: "secret-bot",
      auth: "secret-auth",
      ...config,
    },
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
  };
}

const originalFetch = globalThis.fetch;
let captured: CapturedRequest[] = [];

function setFetchResponse(response: Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      init: init ?? {},
    });
    return response instanceof Promise ? response : response;
  }) as typeof fetch;
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createCustomAdapter", () => {
  test("identity fields", () => {
    const adapter = createCustomAdapter(makeAccount());
    expect(adapter.id).toBe("custom:acct-1");
    expect(adapter.channelId).toBe("custom");
    expect(adapter.accountId).toBe("acct-1");
    expect(adapter.name).toBe("My Custom App");
  });

  test("name falls back to 'Custom' when displayName missing", () => {
    const account = makeAccount();
    delete account.displayName;
    const adapter = createCustomAdapter(account);
    expect(adapter.name).toBe("Custom");
  });

  test("start/stop toggle isRunning", async () => {
    const adapter = createCustomAdapter(makeAccount());
    expect(adapter.isRunning()).toBe(false);
    await adapter.start();
    expect(adapter.isRunning()).toBe(true);
    await adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });

  test("sendMessage POSTs to the configured URL with auth headers", async () => {
    setFetchResponse(
      new Response(JSON.stringify({ message_id: "remote-7" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createCustomAdapter(makeAccount());
    const result = await adapter.sendMessage({
      channel: "custom",
      accountId: "acct-1",
      chatId: "chat-9",
      text: "hello",
    });

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) throw new Error("no request captured");

    expect(request.url).toBe("https://example.com/webhook");
    expect(request.init.method).toBe("POST");

    const headers = request.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer secret-bot");
    expect(headers["X-Letta-Auth"]).toBe("secret-auth");

    const body = JSON.parse(request.init.body as string);
    expect(body).toMatchObject({
      channel: "custom",
      account_id: "acct-1",
      chat_id: "chat-9",
      text: "hello",
    });

    expect(result.messageId).toBe("remote-7");
  });

  test("sendMessage falls back to a uuid when remote omits message_id", async () => {
    setFetchResponse(new Response("ok", { status: 200 }));

    const adapter = createCustomAdapter(makeAccount());
    const result = await adapter.sendMessage({
      channel: "custom",
      accountId: "acct-1",
      chatId: "chat-9",
      text: "hello",
    });

    expect(typeof result.messageId).toBe("string");
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  test("sendMessage throws when URL is missing", async () => {
    const account = makeAccount();
    delete account.config.url;
    const adapter = createCustomAdapter(account);

    await expect(
      adapter.sendMessage({
        channel: "custom",
        accountId: "acct-1",
        chatId: "chat-9",
        text: "hi",
      }),
    ).rejects.toThrow(/missing a webhook URL/i);
  });

  test("sendMessage throws on non-2xx response", async () => {
    setFetchResponse(
      new Response("server boom", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const adapter = createCustomAdapter(makeAccount());
    await expect(
      adapter.sendMessage({
        channel: "custom",
        accountId: "acct-1",
        chatId: "chat-9",
        text: "hi",
      }),
    ).rejects.toThrow(/502/);
  });

  test("sendMessage omits Authorization when bot_token blank", async () => {
    setFetchResponse(new Response("ok", { status: 200 }));
    const adapter = createCustomAdapter(makeAccount({ bot_token: "" }));

    await adapter.sendMessage({
      channel: "custom",
      accountId: "acct-1",
      chatId: "chat-9",
      text: "hi",
    });

    const request = captured[0];
    if (!request) throw new Error("no request captured");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Letta-Auth"]).toBe("secret-auth");
  });

  test("sendDirectReply forwards through deliver", async () => {
    setFetchResponse(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createCustomAdapter(makeAccount());
    await adapter.sendDirectReply("chat-1", "ping", {
      replyToMessageId: "mid-7",
    });

    const request = captured[0];
    if (!request) throw new Error("no request captured");
    const body = JSON.parse(request.init.body as string);
    expect(body.chat_id).toBe("chat-1");
    expect(body.text).toBe("ping");
    expect(body.reply_to_message_id).toBe("mid-7");
  });
});
