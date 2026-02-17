import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import {
  mergeQueuedTurnInput,
  type QueuedTurnInput,
} from "../../queue/turnQueueRuntime";

describe("turnQueueRuntime", () => {
  test("merges user and task notification entries with separators", () => {
    const queued: QueuedTurnInput<string>[] = [
      { kind: "user", content: "hello" },
      {
        kind: "task_notification",
        text: "<task-notification>done</task-notification>",
      },
      { kind: "user", content: "world" },
    ];

    const merged = mergeQueuedTurnInput(queued, {
      normalizeUserContent: (content) => content,
    });

    expect(Array.isArray(merged)).toBe(true);
    if (!Array.isArray(merged)) return;
    const text = merged.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(text.join("")).toBe(
      "hello\n<task-notification>done</task-notification>\nworld",
    );
  });

  test("preserves multimodal user content", () => {
    const content = [
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const queued: QueuedTurnInput<MessageCreate["content"]>[] = [
      { kind: "user", content },
    ];

    const merged = mergeQueuedTurnInput(queued, {
      normalizeUserContent: (userContent) => userContent,
    });

    expect(Array.isArray(merged)).toBe(true);
    if (!Array.isArray(merged)) return;
    expect(merged[0]).toEqual(content[0]);
    expect(merged[1]).toEqual(content[1]);
  });

  test("returns null when no queued items exist", () => {
    expect(
      mergeQueuedTurnInput([], {
        normalizeUserContent: (content: string) => content,
      }),
    ).toBeNull();
  });
});
