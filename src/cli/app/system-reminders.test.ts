import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { getRestorableUserText } from "./system-reminders";

describe("getRestorableUserText", () => {
  test("ignores malformed runtime parts while preserving valid approval-recovery text", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          null,
          1,
          { type: "text", text: 4 },
          { type: "text", text: "keep" },
        ],
      },
    ] as unknown as MessageCreate[];
    expect(getRestorableUserText(input)).toBe("keep");
  });
  test("strips reminders from string content and skips approvals", () => {
    const text = getRestorableUserText([
      { type: "approval", approvals: [] },
      {
        type: "message",
        role: "user",
        content: `${SYSTEM_REMINDER_OPEN}x${SYSTEM_REMINDER_CLOSE}hello`,
      },
    ]);
    expect(text).toBe("hello");
  });

  test("joins text parts and drops reminder parts", () => {
    const text = getRestorableUserText([
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: `${SYSTEM_REMINDER_OPEN}x` },
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(text).toBe("a\nb");
  });

  test("returns empty string without a message", () => {
    expect(getRestorableUserText([{ type: "approval", approvals: [] }])).toBe(
      "",
    );
  });
});
