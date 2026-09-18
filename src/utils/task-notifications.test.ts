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
