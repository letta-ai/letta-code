import { describe, expect, test } from "bun:test";
import type { ApprovalResult } from "@/agent/approval-execution";
import { createBuffers } from "@/cli/helpers/accumulator";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import {
  bindTuiClientPreferences,
  buildTuiTurnInput,
  prepareTuiQueuedTurn,
} from "./turn-input";

const approvals: ApprovalResult[] = [
  {
    type: "tool",
    tool_call_id: "tool-1",
    tool_return: "done",
    status: "success",
  },
];

describe("native TUI turn input", () => {
  test("command continuations preserve caller origin and execution options", async () => {
    for (const clientPreferences of [undefined, {}]) {
      let called = false;
      const input = buildTuiTurnInput({ content: "/command" });
      const submit = bindTuiClientPreferences(async (received, options) => {
        called = true;
        expect(received).toBe(input);
        expect(options).toEqual({ allowReentry: true, clientPreferences });
      }, clientPreferences);
      await submit(input, { allowReentry: true });
      expect(called).toBe(true);
    }
  });
  test("recovery and queued approvals precede the user message", () => {
    const message = {
      type: "message" as const,
      role: "user" as const,
      content: "hello",
      otid: "user-id",
    };
    const queuedApproval = {
      type: "approval" as const,
      approvals,
      otid: "queued-id",
    };
    const input = buildTuiTurnInput({ approvals, queuedApproval, ...message });
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ type: "approval", approvals });
    expect(input[1]).toBe(queuedApproval);
    expect(input[2]).toEqual(message);
    expect(buildTuiTurnInput({ approvals: [], ...message })).toEqual([message]);
  });

  for (const item of [
    { kind: "user", text: "human request" },
    { kind: "user", source: "cron", text: "scheduled request" },
    {
      kind: "task_notification",
      text: "<task-notification>done</task-notification>",
    },
  ] satisfies QueuedMessage[]) {
    test(`mid-turn ${item.source ?? item.kind} preserves input and origin`, () => {
      const buffers = createBuffers();
      const turn = prepareTuiQueuedTurn([item], approvals, buffers);
      expect(turn.hasQueuedMessage).toBe(true);
      expect(turn.options.allowReentry).toBe(true);
      expect(turn.options.clientPreferences).toEqual(
        item.kind === "user" && item.source !== "cron" ? {} : undefined,
      );
      expect(turn.input[0]).toMatchObject({ type: "approval", approvals });
      expect(turn.input[1]).toMatchObject({ type: "message", role: "user" });
      const optimistic = buffers.order.map((id) => buffers.byId.get(id));
      if (item.kind === "user") {
        expect(optimistic).toHaveLength(1);
        expect(optimistic[0]).toMatchObject({
          text: item.text,
          otid: turn.input[1]?.otid,
        });
      } else {
        expect(optimistic).toEqual([]);
      }
    });
  }

  test("approval-only continuation inherits preferences and creates no user bubble", () => {
    const buffers = createBuffers();
    const turn = prepareTuiQueuedTurn(null, approvals, buffers);
    expect(turn.hasQueuedMessage).toBe(false);
    expect(turn.options.clientPreferences).toBeUndefined();
    expect(turn.input).toHaveLength(1);
    expect(buffers.order).toEqual([]);
  });
});
