import { describe, expect, test } from "bun:test";
import {
  findTrailingLocalToolExchange,
  planLocalAllCompaction,
} from "@/backend/local/compaction-all-plan";
import { estimateLocalMessagesTokens } from "@/backend/local/local-context-estimate";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalMessage,
  type LocalToolResultMessage,
} from "@/backend/local/local-message";

function user(id: string, text: string): LocalMessage {
  return { id, role: "user", content: text, timestamp: 1 };
}

function assistant(
  id: string,
  callIds: string[],
  stopReason: LocalAssistantMessage["stopReason"] = "toolUse",
): LocalAssistantMessage {
  return {
    id,
    role: "assistant",
    content: [
      { type: "text", text: "Running tools." },
      ...callIds.map((callId) => ({
        type: "toolCall" as const,
        id: callId,
        name: "Bash",
        arguments: { command: `echo ${callId}` },
      })),
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason,
    timestamp: 1,
  };
}

function result(
  id: string,
  toolCallId: string,
  text = "output",
): LocalToolResultMessage {
  return {
    id,
    role: "toolResult",
    toolCallId,
    toolName: "Bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

const prefix = [
  user("u1", "inspect the logs"),
  assistant("a1", ["call-1"]),
  result("r1", "call-1"),
];

describe("findTrailingLocalToolExchange", () => {
  test.each<[string, LocalMessage[], number | undefined]>([
    [
      "finds a single call followed by its result",
      [...prefix, assistant("a2", ["call-2"]), result("r2", "call-2")],
      3,
    ],
    [
      "finds parallel calls whose results arrive in any order",
      [
        ...prefix,
        assistant("a2", ["call-a", "call-b", "call-c"]),
        result("rc", "call-c"),
        result("ra", "call-a"),
        result("rb", "call-b"),
      ],
      3,
    ],
    [
      "matches a `|`-suffixed call id by the part before the `|`",
      [...prefix, assistant("a2", ["call-2|fc-2"]), result("r2", "call-2")],
      3,
    ],
    [
      "ignores an exchange in which a call still lacks its result",
      [
        ...prefix,
        assistant("a2", ["call-a", "call-b"]),
        result("ra", "call-a"),
      ],
      undefined,
    ],
    [
      "ignores an exchange in which one call has two results",
      [
        ...prefix,
        assistant("a2", ["call-a", "call-b"]),
        result("ra", "call-a"),
        result("ra2", "call-a"),
      ],
      undefined,
    ],
    [
      "ignores results that answer a different call",
      [...prefix, assistant("a2", ["call-a"]), result("rx", "call-x")],
      undefined,
    ],
    [
      "ignores a conversation that ends in a user message",
      [...prefix, user("u2", "and now?")],
      undefined,
    ],
    [
      "ignores a conversation that ends in a pending call",
      [...prefix, assistant("a2", ["call-2"])],
      undefined,
    ],
    ["ignores an empty conversation", [], undefined],
    [
      "ignores the calls of an assistant message the request would drop",
      [
        user("u1", "inspect the logs"),
        assistant("a1", ["call-1"], "aborted"),
        result("r1", "call-1"),
      ],
      undefined,
    ],
  ])("%s", (_name, messages, expected) => {
    expect(findTrailingLocalToolExchange(messages)).toBe(expected);
  });
});

describe("planLocalAllCompaction", () => {
  const exchange = [assistant("a2", ["call-2"]), result("r2", "call-2")];
  const messages = [...prefix, ...exchange];
  const exchangeTokens = estimateLocalMessagesTokens(exchange);

  test("keeps a completed exchange that fits the budget", () => {
    expect(
      planLocalAllCompaction(messages, { toolExchangeBudget: exchangeTokens }),
    ).toEqual({
      messagesToSummarize: prefix,
      messagesToKeep: exchange,
      keepsToolExchange: true,
    });
  });

  test("summarises an exchange over the budget with everything else", () => {
    expect(
      planLocalAllCompaction(messages, {
        toolExchangeBudget: exchangeTokens - 1,
      }),
    ).toEqual({ messagesToSummarize: messages, messagesToKeep: [] });
  });

  test("summarises the exchange without a budget (manual and overflow compaction)", () => {
    expect(planLocalAllCompaction(messages)).toEqual({
      messagesToSummarize: messages,
      messagesToKeep: [],
    });
  });

  test("summarises an exchange with nothing before it", () => {
    expect(
      planLocalAllCompaction(exchange, { toolExchangeBudget: 1_000_000 }),
    ).toEqual({ messagesToSummarize: exchange, messagesToKeep: [] });
  });

  test("summarises an incomplete exchange", () => {
    const incomplete = [
      ...prefix,
      assistant("a2", ["call-a", "call-b"]),
      result("ra", "call-a"),
    ];
    expect(
      planLocalAllCompaction(incomplete, { toolExchangeBudget: 1_000_000 }),
    ).toEqual({ messagesToSummarize: incomplete, messagesToKeep: [] });
  });

  test("keeps only a pending call, with or without a budget", () => {
    const pendingCall = assistant("a2", ["call-2"]);
    const pending = [...prefix, pendingCall];
    const expected = {
      messagesToSummarize: prefix,
      messagesToKeep: [pendingCall],
    };
    expect(planLocalAllCompaction(pending)).toEqual(expected);
    expect(
      planLocalAllCompaction(pending, { toolExchangeBudget: 1_000_000 }),
    ).toEqual(expected);
  });
});
