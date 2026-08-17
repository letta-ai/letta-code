import { expect, test } from "bun:test";
import type { TelegramLikeMessage } from "./media";
import { getTelegramMessageThreadId } from "./utils";

function threadMessage(overrides: {
  chatType?: string;
  isForum?: boolean;
  threadId?: number;
  isTopicMessage?: boolean;
}): TelegramLikeMessage {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: -100123,
      type: overrides.chatType,
      is_forum: overrides.isForum,
    },
    message_thread_id: overrides.threadId,
    is_topic_message: overrides.isTopicMessage,
  };
}

const cases: Array<{
  name: string;
  message: TelegramLikeMessage;
  expected: string | null;
}> = [
  {
    name: "non-forum group with a spurious thread id",
    message: threadMessage({ chatType: "group", threadId: 101 }),
    expected: null,
  },
  {
    name: "non-forum group with a different spurious thread id",
    message: threadMessage({ chatType: "group", threadId: 202 }),
    expected: null,
  },
  {
    name: "non-forum supergroup with a spurious thread id",
    message: threadMessage({ chatType: "supergroup", threadId: 101 }),
    expected: null,
  },
  {
    name: "forum General / reply-thread without is_topic_message",
    message: threadMessage({
      chatType: "supergroup",
      isForum: true,
      threadId: 42,
    }),
    expected: null,
  },
  {
    name: "forum General with is_topic_message explicitly false",
    message: threadMessage({
      chatType: "supergroup",
      isForum: true,
      threadId: 42,
      isTopicMessage: false,
    }),
    expected: null,
  },
  {
    name: "forum named topic with is_topic_message",
    message: threadMessage({
      chatType: "supergroup",
      isForum: true,
      threadId: 42,
      isTopicMessage: true,
    }),
    expected: "42",
  },
  {
    name: "named group topic without is_forum",
    message: threadMessage({
      chatType: "group",
      threadId: 42,
      isTopicMessage: true,
    }),
    expected: "42",
  },
  {
    name: "private bot topic without is_topic_message",
    message: threadMessage({ chatType: "private", threadId: 42 }),
    expected: "42",
  },
  {
    name: "private bot topic with is_topic_message",
    message: threadMessage({
      chatType: "private",
      threadId: 42,
      isTopicMessage: true,
    }),
    expected: "42",
  },
  {
    name: "missing message_thread_id",
    message: threadMessage({ chatType: "supergroup", isForum: true }),
    expected: null,
  },
];

for (const { name, message, expected } of cases) {
  test(`getTelegramMessageThreadId: ${name}`, () => {
    expect(getTelegramMessageThreadId(message)).toBe(expected);
  });
}
