import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { prepareMessageHistory } from "@/agent/check-approval";

function msg(
  type: string,
  id: string,
  dateMs: number,
  extra?: Record<string, unknown>,
): Message {
  return {
    id,
    message_type: type,
    date: new Date(dateMs).toISOString(),
    ...(extra ?? {}),
  } as unknown as Message;
}

describe("prepareMessageHistory", () => {
  test("keeps renderable tool messages in transcript order", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [
      msg("user_message", "u1", base + 1),
      msg("tool_call_message", "tc1", base + 2),
      msg("approval_request_message", "ar1", base + 3),
      msg("tool_return_message", "tr1", base + 4),
      msg("assistant_message", "a1", base + 5),
      msg("reasoning_message", "r1", base + 6),
      msg("approval_response_message", "ap1", base + 7),
      msg("event_message", "e1", base + 8),
      msg("summary_message", "s1", base + 9),
    ];

    const out = prepareMessageHistory(messages);
    expect(out.map((m) => m.message_type)).toEqual([
      "user_message",
      "tool_call_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
      "reasoning_message",
      "approval_response_message",
      "event_message",
      "summary_message",
    ]);
  });

  test("uses primary anchors for recency without dropping intervening tools", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [];

    for (let i = 0; i < 14; i += 1) {
      messages.push(msg("user_message", `u${i}`, base + 10 + i));
      if (i === 12) {
        messages.push(msg("approval_request_message", "tool-12", base + 100));
        messages.push(msg("tool_return_message", "return-12", base + 101));
      }
    }
    messages.push(msg("assistant_message", "a1", base + 200));

    const out = prepareMessageHistory(messages);
    expect(out.map((m) => m.id)).toEqual([
      "u5",
      "u6",
      "u7",
      "u8",
      "u9",
      "u10",
      "u11",
      "u12",
      "tool-12",
      "return-12",
      "u13",
      "a1",
    ]);
  });

  test("skips orphaned leading tool_return_message", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [
      msg("tool_return_message", "tr1", base + 1),
      msg("assistant_message", "a1", base + 2),
    ];

    const out = prepareMessageHistory(messages);
    expect(out[0]?.message_type).toBe("assistant_message");
  });
});
