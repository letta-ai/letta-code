import { getRuntimeContext } from "@/runtime-context";
import type { TaskStoreScope } from "./store.js";

export function requireTaskStoreScope(): TaskStoreScope {
  const runtimeContext = getRuntimeContext();
  const agentId = runtimeContext?.agentId;
  const conversationId = runtimeContext?.conversationId;

  if (!agentId || !conversationId) {
    throw new Error(
      "Task tools require an agent and conversation execution scope",
    );
  }

  return { agentId, conversationId };
}
