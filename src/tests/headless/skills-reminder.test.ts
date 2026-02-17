import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Line } from "../../cli/helpers/accumulator";
import {
  prependSkillsReminderToContent,
  shouldReinjectSkillsAfterCompaction,
} from "../../headless";

describe("headless skills reminder helpers", () => {
  test("prepends reminder to string user content", () => {
    const result = prependSkillsReminderToContent(
      "hello",
      "<skills>demo</skills>",
    );
    expect(result).toBe("<skills>demo</skills>\n\nhello");
  });

  test("prepends reminder as a text part for multimodal user content", () => {
    const multimodal = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const result = prependSkillsReminderToContent(
      multimodal as MessageCreate["content"],
      "<skills>demo</skills>",
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({
      type: "text",
      text: "<skills>demo</skills>\n\n",
    });
    expect(result[1]).toEqual(multimodal[0]);
    expect(result[2]).toEqual(multimodal[1]);
  });

  test("does not reinject on compaction start event", () => {
    const lines: Line[] = [
      {
        kind: "event",
        id: "evt-1",
        eventType: "compaction",
        eventData: {},
        phase: "running",
      },
    ];
    expect(shouldReinjectSkillsAfterCompaction(lines)).toBe(false);
  });

  test("reinjection triggers after compaction completion", () => {
    const withSummary: Line[] = [
      {
        kind: "event",
        id: "evt-2",
        eventType: "compaction",
        eventData: {},
        phase: "finished",
        summary: "Compacted old messages",
      },
    ];
    expect(shouldReinjectSkillsAfterCompaction(withSummary)).toBe(true);

    const withStatsOnly: Line[] = [
      {
        kind: "event",
        id: "evt-3",
        eventType: "compaction",
        eventData: {},
        phase: "finished",
        stats: {
          contextTokensBefore: 12000,
          contextTokensAfter: 7000,
        },
      },
    ];
    expect(shouldReinjectSkillsAfterCompaction(withStatsOnly)).toBe(true);
  });
});
