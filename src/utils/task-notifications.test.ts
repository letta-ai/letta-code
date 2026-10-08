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
