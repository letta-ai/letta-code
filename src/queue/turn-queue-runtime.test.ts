import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  composeModTurnInput,
  mergeQueuedTurnInput,
  type QueuedTurnInput,
  shouldEmitModTurnStart,
} from "@/queue/turn-queue-runtime";

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

  test("ignores null normalized content instead of spreading it", () => {
    const queued: QueuedTurnInput<null>[] = [{ kind: "user", content: null }];

    const merged = mergeQueuedTurnInput(queued, {
      normalizeUserContent: () => null as unknown as MessageCreate["content"],
    });

    expect(merged).toBeNull();
  });

  test("stringifies unexpected normalized content instead of spreading it", () => {
    const queued: QueuedTurnInput<Record<string, string>>[] = [
      { kind: "user", content: { ref: "" } },
    ];

    const merged = mergeQueuedTurnInput(queued, {
      normalizeUserContent: (content) =>
        content as unknown as MessageCreate["content"],
    });

    expect(Array.isArray(merged)).toBe(true);
    if (!Array.isArray(merged)) return;
    expect(merged).toEqual([{ type: "text", text: '{"ref":""}' }]);
  });

  test("returns null when no queued items exist", () => {
    expect(
      mergeQueuedTurnInput([], {
        normalizeUserContent: (content: string) => content,
      }),
    ).toBeNull();
  });

  test("keeps approval-only input outside the mod turn-start trigger", () => {
    const approval = {
      type: "approval",
      approvals: [{ tool_call_id: "tool-1", approve: true }],
    } as unknown as ApprovalCreate;

    expect(shouldEmitModTurnStart([approval])).toBe(false);
  });

  test("keeps approvals first when a legacy mod prepends context", () => {
    const approval = {
      type: "approval",
      approvals: [{ tool_call_id: "tool-1", approve: true }],
    } as unknown as ApprovalCreate;
    const notification = {
      role: "user",
      content: "<task-notification>done</task-notification>",
    } as MessageCreate;
    const reminder = {
      role: "user",
      content: "<goal-reminder>stay focused</goal-reminder>",
    } as MessageCreate;

    const composed = composeModTurnInput({
      originalInput: [approval, notification],
      transformedInput: [reminder, approval, notification],
      queueItems: [],
    });

    expect(composed).toEqual([approval, reminder, notification]);
  });

  test("composes passive mod context after approvals and before queued input", () => {
    const approval = {
      type: "approval",
      approvals: [{ tool_call_id: "tool-1", approve: true }],
    } as unknown as ApprovalCreate;
    const notification = {
      role: "user",
      content: "<task-notification>done</task-notification>",
    } as MessageCreate;

    expect(shouldEmitModTurnStart([approval, notification])).toBe(true);

    const composed = composeModTurnInput({
      originalInput: [approval, notification],
      transformedInput: [approval, notification],
      queueItems: [
        {
          kind: "context",
          content: "<goal-reminder>stay focused</goal-reminder>",
        },
      ],
    });

    expect(composed[0]).toBe(approval);
    expect(composed[2]).toBe(notification);
    expect(composed[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<goal-reminder>stay focused</goal-reminder>",
        },
      ],
    });
  });

  test("does not let mods replace approval continuation objects", () => {
    const approval = {
      type: "approval",
      approvals: [{ tool_call_id: "tool-1", approve: true }],
    } as unknown as ApprovalCreate;
    const replacement = {
      type: "approval",
      approvals: [{ tool_call_id: "tool-2", approve: false }],
    } as unknown as ApprovalCreate;

    const composed = composeModTurnInput({
      originalInput: [approval],
      transformedInput: [replacement],
      queueItems: [],
    });

    expect(composed).toEqual([approval]);
  });

  test("preserves approval objects whose optional discriminator is absent", () => {
    const approval = {
      approvals: [{ tool_call_id: "tool-1", approve: true }],
    } as unknown as ApprovalCreate;

    const composed = composeModTurnInput({
      originalInput: [approval],
      transformedInput: [],
      queueItems: [{ kind: "context", content: "context" }],
    });

    expect(composed[0]).toBe(approval);
  });
});
