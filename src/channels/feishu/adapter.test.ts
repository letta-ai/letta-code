import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __testResetFeishuAppIdOwners,
  createFeishuAdapter,
} from "@/channels/feishu/adapter";
import type { LarkRuntimeModuleLike } from "@/channels/feishu/internal-types";
import { FEISHU_API_DOMAINS } from "@/channels/feishu/internal-types";
import type {
  FeishuChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";

class FakeEventDispatcher {
  readonly handlers = new Map<
    string,
    (data: unknown) => Promise<unknown> | unknown
  >();

  register(
    handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>,
  ): this {
    for (const [key, handler] of Object.entries(handlers)) {
      this.handlers.set(key, handler);
    }
    return this;
  }
}

class FakeClient {
  static instances: FakeClient[] = [];
  readonly domain: unknown;
  readonly create = mock(async (_request: unknown) => ({
    data: { message_id: "om_sent" },
  }));
  readonly reply = mock(async (_request: unknown) => ({
    data: { message_id: "om_reply" },
  }));

  constructor(config: { domain?: unknown }) {
    this.domain = config.domain;
    FakeClient.instances.push(this);
  }

  readonly im = {
    v1: {
      message: {
        create: (request: unknown) => this.create(request),
        reply: (request: unknown) => this.reply(request),
      },
    },
  };
}

class FakeWSClient {
  static instances: FakeWSClient[] = [];
  dispatcher: FakeEventDispatcher | null = null;
  readonly domain: unknown;
  readonly start = mock(
    async (options: { eventDispatcher: FakeEventDispatcher }) => {
      this.dispatcher = options.eventDispatcher;
    },
  );
  readonly close = mock(() => {});

  constructor(config: { domain?: unknown }) {
    this.domain = config.domain;
    FakeWSClient.instances.push(this);
  }

  async emitReceive(data: unknown): Promise<void> {
    await this.dispatcher?.handlers.get("im.message.receive_v1")?.(data);
  }
}

function fakeRuntime(): LarkRuntimeModuleLike {
  return {
    Domain: {
      Feishu: FEISHU_API_DOMAINS.feishu,
      Lark: FEISHU_API_DOMAINS.lark,
    },
    Client: FakeClient as unknown as LarkRuntimeModuleLike["Client"],
    WSClient: FakeWSClient as unknown as LarkRuntimeModuleLike["WSClient"],
    EventDispatcher:
      FakeEventDispatcher as unknown as LarkRuntimeModuleLike["EventDispatcher"],
  };
}

function account(
  overrides: Partial<FeishuChannelAccount> = {},
): FeishuChannelAccount {
  return {
    channel: "feishu",
    accountId: overrides.accountId ?? "acct-feishu",
    enabled: true,
    appId: "cli_app",
    appSecret: "secret",
    domain: "feishu",
    groupMode: "mention-only",
    agentId: "agent-1",
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function botMentionEvent(overrides?: {
  messageId?: string;
  eventId?: string;
  chatType?: string;
}): unknown {
  return {
    header: {
      event_id: overrides?.eventId ?? "evt_1",
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_user" },
        sender_type: "user",
      },
      message: {
        message_id: overrides?.messageId ?? "om_1",
        chat_id: "oc_group",
        chat_type: overrides?.chatType ?? "group",
        message_type: "text",
        content: '{"text":"@_user_1 ping"}',
        mentions: [
          {
            key: "@_user_1",
            mentioned_type: "bot",
            id: { open_id: "ou_bot" },
          },
        ],
      },
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("feishu adapter", () => {
  afterEach(async () => {
    __testResetFeishuAppIdOwners();
    FakeClient.instances = [];
    FakeWSClient.instances = [];
  });

  test("domain lark constructs the Lark API domain", async () => {
    const adapter = createFeishuAdapter(account({ domain: "lark" }), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    await adapter.start();
    expect(FakeClient.instances[0]?.domain).toBe(FEISHU_API_DOMAINS.lark);
    expect(FakeWSClient.instances[0]?.domain).toBe(FEISHU_API_DOMAINS.lark);
    await adapter.stop();
  });

  test("same message_id with different event_id is delivered once", async () => {
    const adapter = createFeishuAdapter(account(), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    const received: InboundChannelMessage[] = [];
    adapter.onMessage = async (msg) => {
      received.push(msg);
    };
    await adapter.start();
    const ws = FakeWSClient.instances[0];
    await ws?.emitReceive(
      botMentionEvent({ messageId: "om_dup", eventId: "evt_a" }),
    );
    await flush();
    await ws?.emitReceive(
      botMentionEvent({ messageId: "om_dup", eventId: "evt_b" }),
    );
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe("om_dup");
    await adapter.stop();
  });

  test("onMessage errors do not throw back to the SDK handler", async () => {
    const adapter = createFeishuAdapter(account(), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    adapter.onMessage = async () => {
      throw new Error("turn failed");
    };
    await adapter.start();
    await expect(
      FakeWSClient.instances[0]?.emitReceive(botMentionEvent()),
    ).resolves.toBeUndefined();
    await adapter.stop();
  });

  test("second start with the same App ID fails loudly", async () => {
    const first = createFeishuAdapter(account({ accountId: "one" }), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    const second = createFeishuAdapter(account({ accountId: "two" }), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    await first.start();
    await expect(second.start()).rejects.toThrow(/already connected/);
    await first.stop();
  });

  test("sendMessage uses receive_id_type chat_id", async () => {
    const adapter = createFeishuAdapter(account(), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    await adapter.start();
    const result = await adapter.sendMessage({
      channel: "feishu",
      chatId: "oc_group",
      text: "hello",
    });
    expect(result.messageId).toBe("om_sent");
    expect(FakeClient.instances[0]?.create).toHaveBeenCalledTimes(1);
    expect(FakeClient.instances[0]?.create.mock.calls[0]?.[0]).toEqual({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_group",
        msg_type: "text",
        content: '{"text":"hello"}',
      },
    });
    await adapter.stop();
  });

  test("lifecycle errors are sanitized before posting to the chat", async () => {
    const adapter = createFeishuAdapter(account(), {
      loadRuntimeModule: async () => fakeRuntime(),
    });
    await adapter.start();
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [
        {
          channel: "feishu",
          chatId: "oc_group",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      ],
      outcome: "error",
      stopReason: "error",
      error: "Unexpected stop reason: error",
    });
    const request = FakeClient.instances[0]?.create.mock.calls[0]?.[0] as {
      data: { content: string };
    };
    expect(request.data.content).not.toContain("Unexpected stop reason");
    expect(request.data.content).toContain(
      "Something went wrong while processing that message",
    );
    await adapter.stop();
  });
});
