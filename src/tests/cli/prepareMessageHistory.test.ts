import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { prepareMessageHistory } from "../../agent/check-approval";

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
  test("primaryOnly returns only primary message types", () => {
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

    const out = prepareMessageHistory(messages, { primaryOnly: true });
    expect(out.map((m) => m.message_type)).toEqual([
      "user_message",
      "assistant_message",
      "event_message",
      "summary_message",
    ]);
  });

  test("primaryOnly includes most recent assistant even if last N primary messages lack it", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [];

    // An older assistant message, then many user/event messages.
    messages.push(msg("assistant_message", "a1", base + 1));
    for (let i = 0; i < 30; i += 1) {
      messages.push(msg("user_message", `u${i}`, base + 10 + i));
    }

    const out = prepareMessageHistory(messages, { primaryOnly: true });
    expect(out.some((m) => m.message_type === "assistant_message")).toBe(true);
    expect(
      out.every((m) =>
        [
          "user_message",
          "assistant_message",
          "event_message",
          "summary_message",
        ].includes(m.message_type as string),
      ),
    ).toBe(true);
  });

  test("primaryOnly falls back to reasoning when no primary messages exist", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [
      msg("tool_return_message", "tr1", base + 1),
      msg("reasoning_message", "r1", base + 2),
      msg("tool_return_message", "tr2", base + 3),
      msg("reasoning_message", "r2", base + 4),
    ];

    const out = prepareMessageHistory(messages, { primaryOnly: true });
    expect(out.map((m) => m.message_type)).toEqual([
      "reasoning_message",
      "reasoning_message",
    ]);
  });

  test("primaryOnly returns [] when no primary or reasoning messages exist", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [
      msg("tool_return_message", "tr1", base + 1),
      msg("approval_request_message", "ar1", base + 2),
      msg("approval_response_message", "ap1", base + 3),
    ];

    const out = prepareMessageHistory(messages, { primaryOnly: true });
    expect(out).toEqual([]);
  });

  test("non-primaryOnly skips orphaned leading tool_return_message", () => {
    const base = 1_700_000_000_000;
    const messages: Message[] = [
      msg("tool_return_message", "tr1", base + 1),
      msg("assistant_message", "a1", base + 2),
    ];

    const out = prepareMessageHistory(messages);
    expect(out[0]?.message_type).toBe("assistant_message");
  });
});
