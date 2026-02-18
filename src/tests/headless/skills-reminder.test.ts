import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { prependReminderPartsToContent } from "../../reminders/engine";

describe("headless shared reminder content helpers", () => {
  test("prepends reminder text to string user content", () => {
    const result = prependReminderPartsToContent("hello", [
      { type: "text", text: "<skills>demo</skills>" },
    ]);
    expect(result).toBe("<skills>demo</skills>\n\nhello");
  });

  test("prepends reminder parts for multimodal user content", () => {
    const multimodal = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const result = prependReminderPartsToContent(
      multimodal as MessageCreate["content"],
      [{ type: "text", text: "<skills>demo</skills>" }],
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({
      type: "text",
      text: "<skills>demo</skills>",
    });
    expect(result[1]).toEqual(multimodal[0]);
    expect(result[2]).toEqual(multimodal[1]);
  });
});
