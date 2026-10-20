import { expect, test } from "bun:test";
import { runWithRuntimeContext, updateRuntimeContext } from "@/runtime-context";
import { resolveNotificationScope } from "./task-notifications";

for (const actingUserId of ["user-a", undefined]) {
  test(`notification scope retains ${actingUserId ?? "anonymous"} ownership after the turn changes`, () => {
    runWithRuntimeContext({ actingUserId }, () => {
      const scope = resolveNotificationScope({
        agentId: "agent-a",
        conversationId: "conv-a",
      });
      updateRuntimeContext({
        actingUserId: "user-b",
        agentId: "agent-b",
        conversationId: "conv-b",
      });
      expect(scope).toEqual({
        agentId: "agent-a",
        conversationId: "conv-a",
        actingUserId,
      });
    });
  });
}

test("notification scope preserves explicit ambient-actor suppression", () => {
  runWithRuntimeContext(
    {
      actingUserId: "ambient-user",
      suppressActingUserFallback: true,
    },
    () => {
      expect(
        resolveNotificationScope({
          agentId: "agent-a",
          conversationId: "conv-a",
        }),
      ).toEqual({
        agentId: "agent-a",
        conversationId: "conv-a",
        actingUserId: null,
      });
    },
  );
});

import { selectStopFailedNotifications } from "./task-notifications";

test("stop-failed notifications surface once per live row and respect conversation scope", () => {
  const seen = new Set<string>();
  const rows = [
    {
      id: "sub_a",
      description: "deploy check",
      status: "running",
      stopFailed: true,
      parentConversationId: "conv-1",
    },
    {
      id: "sub_b",
      description: "other conversation",
      status: "running",
      stopFailed: true,
      parentConversationId: "conv-2",
    },
    {
      id: "sub_c",
      description: "already settled",
      status: "error",
      stopFailed: true,
      parentConversationId: "conv-1",
    },
    {
      id: "sub_d",
      description: "healthy task",
      status: "running",
      parentConversationId: "conv-1",
    },
  ];

  const first = selectStopFailedNotifications(rows, seen, {
    conversationId: "conv-1",
  });
  expect(first).toEqual([
    'Background task "deploy check" could not be stopped — still running remotely. Press Esc to retry.',
  ]);

  // Deduplicated: the same row never notifies twice, and other
  // conversations' failures stay silent in this one.
  const second = selectStopFailedNotifications(rows, seen, {
    conversationId: "conv-1",
  });
  expect(second).toEqual([]);

  // A row with no parent conversation (legacy) still notifies in scope.
  const legacy = selectStopFailedNotifications(
    [
      {
        id: "sub_e",
        description: "legacy row",
        status: "running",
        stopFailed: true,
      },
    ],
    seen,
    { conversationId: "conv-1" },
  );
  expect(legacy).toEqual([
    'Background task "legacy row" could not be stopped — still running remotely. Press Esc to retry.',
  ]);
});
