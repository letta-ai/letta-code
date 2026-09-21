import { describe, expect, mock, test } from "bun:test";
import {
  type ChannelBindingLookup,
  formatSlackBindingNotice,
} from "./message-channel-bindings";
import {
  type ExecuteMessageChannelOptions,
  executeMessageChannel,
} from "./message-channel-executor";
import { buildMessageChannelExternalToolDefinition } from "./message-channel-tool-definition";
import { createSlackMessageActionAdapter } from "./slack/message-action-contract";

const scope = { agentId: "agent-a", conversationId: "conv-a" };
const binding: ChannelBindingLookup = {
  channel: "slack",
  accountId: "app-a",
  chatId: "C123",
  threadId: "100.1",
  binding: {
    conversationId: "conv-b",
    enabled: true,
    outboundEnabled: true,
    detached: false,
  },
};

function fixture() {
  const get = mock(async () => binding);
  const update = mock(async () => ({
    ...binding,
    status: "updated" as const,
    previousConversationId: "conv-a",
  }));
  const resolveRoutedContext = mock(async () => null);
  const options: ExecuteMessageChannelOptions = {
    scope,
    bindings: { get, update },
    resolver: { isSupportedChannel: () => true, resolveRoutedContext },
  };
  return { options, get, update, resolveRoutedContext };
}

const getInput = {
  action: "get-binding",
  channel: "slack",
  chat_id: "C123",
  threadId: "100.1",
};

describe("host-owned MessageChannel bindings", () => {
  test("reads another conversation's binding without resolving a send route", async () => {
    const f = fixture();
    const result = await executeMessageChannel(getInput, f.options);
    expect(JSON.parse(result)).toEqual(binding);
    expect(f.get).toHaveBeenCalledWith(
      {
        channel: "slack",
        chatId: "C123",
        accountId: undefined,
        threadId: "100.1",
      },
      scope,
    );
    expect(f.resolveRoutedContext).not.toHaveBeenCalled();
  });

  test.each([undefined, "", "__root__", "not-a-timestamp"])(
    "rejects missing or ambiguous thread identity %s",
    async (threadId) => {
      const f = fixture();
      expect(
        await executeMessageChannel({ ...getInput, threadId }, f.options),
      ).toContain("require an exact threadId");
      expect(f.get).not.toHaveBeenCalled();
    },
  );

  test("preserves explicit null for an unthreaded DM", async () => {
    const f = fixture();
    await executeMessageChannel(
      { ...getInput, chat_id: "D123", threadId: null },
      f.options,
    );
    expect(f.get).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "D123", threadId: null }),
      scope,
    );
  });

  test("requires both expected and destination conversations for writes", async () => {
    const f = fixture();
    const input = {
      ...getInput,
      action: "update-binding",
      conversationId: "default",
    };
    expect(await executeMessageChannel(input, f.options)).toContain(
      "requires conversationId and expectedConversationId",
    );
    await executeMessageChannel(
      { ...input, expectedConversationId: "conv-b" },
      f.options,
    );
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "default",
        expectedConversationId: "conv-b",
      }),
      scope,
    );
    expect(f.resolveRoutedContext).not.toHaveBeenCalled();
  });

  test("unimplemented hosts and outbound targets cannot mutate bindings", async () => {
    const f = fixture();
    expect(
      await executeMessageChannel(getInput, {
        ...f.options,
        bindings: undefined,
      }),
    ).toStartWith("Error:");
    expect(
      await executeMessageChannel(
        { ...getInput, chat_id: undefined, target: "C123" },
        f.options,
      ),
    ).toContain("target is for outbound sends");
    expect(f.get).not.toHaveBeenCalled();
  });

  test("advertises only host-supported operations and fields", () => {
    for (const supported of [false, true]) {
      const tool = buildMessageChannelExternalToolDefinition({
        scoped: false,
        channels: [
          {
            channelId: "slack",
            displayName: "Slack",
            accountId: "app-a",
            messageActions: createSlackMessageActionAdapter({
              bindings: supported,
            }),
          },
        ],
      });
      const properties = tool.parameters.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(properties.action?.enum?.includes("get-binding")).toBe(supported);
      expect(Boolean(properties.expectedConversationId)).toBe(supported);
      expect(tool.description.includes('action="update-binding"')).toBe(
        supported,
      );
    }
  });

  test("passes an exact thread selector to routed lookup before sending", async () => {
    const sendMessage = mock(async () => ({ messageId: "100.3" }));
    const resolveRoutedContext = mock(
      async (params: { threadId?: string | null }) => ({
        route: {
          ...scope,
          accountId: "app-a",
          chatId: "C123",
          threadId: params.threadId,
        },
        transport: { sendMessage },
        messageActions: createSlackMessageActionAdapter(),
      }),
    );
    const result = await executeMessageChannel(
      { ...getInput, action: "send", message: "hello", threadId: "200.1" },
      {
        scope,
        resolver: { isSupportedChannel: () => true, resolveRoutedContext },
      },
    );
    expect(result).toContain("Message sent");
    expect(resolveRoutedContext).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "200.1" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "200.1" }),
    );
  });

  test("conflicts remain tool errors with the authorized current binding", async () => {
    const f = fixture();
    f.options.bindings = {
      get: f.get,
      update: async () => ({
        ...binding,
        status: "conflict",
        previousConversationId: "conv-b",
      }),
    };
    const result = await executeMessageChannel(
      {
        ...getInput,
        action: "update-binding",
        conversationId: "conv-c",
        expectedConversationId: "conv-a",
      },
      f.options,
    );
    expect(result).toStartWith("Error:");
    expect(result).toContain('"conversationId":"conv-b"');
  });
});

test("send warnings include a usable conditional update and preserve delivery success", async () => {
  const actions = createSlackMessageActionAdapter();
  const result = await actions.handleAction({
    request: {
      action: "send",
      channel: "slack",
      chatId: "C123",
      message: "hello",
      threadId: "100.1",
    },
    route: { ...scope, accountId: "app-a", chatId: "C123", threadId: "100.1" },
    adapter: {
      sendMessage: async () => ({ messageId: "100.2", bindingInfo: binding }),
    },
    formatText: (text) => ({ text }),
  });
  expect(result).toStartWith("Message sent to slack (message_id: 100.2)");
  expect(result).toContain(
    "currently go to conv-b; this conversation is conv-a",
  );
  expect(result).toContain('"expectedConversationId":"conv-b"');
  expect(result).toContain('"conversationId":"conv-a"');
});

test("matching, unbound, paused, detached, and unavailable notices are distinct", () => {
  expect(formatSlackBindingNotice(binding, "conv-b")).toContain(
    "go to this conversation",
  );
  expect(
    formatSlackBindingNotice({ ...binding, binding: null }, "conv-a"),
  ).toContain("no incoming-message binding");
  expect(formatSlackBindingNotice({ unavailable: true }, "conv-a")).toContain(
    "could not be checked",
  );
  const row = binding.binding;
  if (!row) throw new Error("Missing fixture binding");
  expect(
    formatSlackBindingNotice(
      { ...binding, binding: { ...row, enabled: false } },
      "conv-a",
    ),
  ).toContain("paused");
  expect(
    formatSlackBindingNotice(
      { ...binding, binding: { ...row, detached: true } },
      "conv-a",
    ),
  ).toContain("detached");
});
