import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getApprovalRecoveryInputText } from "./approval-retry-input";

describe("approval-recovery input restoration", () => {
  test("does not restore approval payloads or empty text", () => {
    expect(
      getApprovalRecoveryInputText([{ type: "approval", approvals: [] }]),
    ).toBeNull();
    expect(
      getApprovalRecoveryInputText([
        { type: "message", role: "user", content: "  " },
      ]),
    ).toBeNull();
  });
  test("strips injected reminders from string messages", () => {
    expect(
      getApprovalRecoveryInputText([
        {
          type: "message",
          role: "user",
          content: "keep\n<system-reminder>hidden</system-reminder>",
        },
      ]),
    ).toBe("keep");
  });
  test("ignores malformed runtime parts without losing valid text", () => {
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
    expect(getApprovalRecoveryInputText(input)).toBe("keep");
  });
  test("restores text parts without injected reminder parts or image URLs", () => {
    const message: MessageCreate = {
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "<system-reminder>hidden</system-reminder>" },
        { type: "text", text: "second" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/image.png" },
        },
      ],
    };
    expect(getApprovalRecoveryInputText([message])).toBe("first\nsecond");
  });
});
