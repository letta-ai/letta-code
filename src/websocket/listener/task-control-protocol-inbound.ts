import type {
  MonitorStopCommand,
  RemoveQueueItemCommand,
} from "@/types/task-control-protocol";
import { isAgentRuntimeScope } from "./protocol-validation";

export function isRemoveQueueItemCommand(
  value: unknown,
): value is RemoveQueueItemCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<RemoveQueueItemCommand>;
  return (
    c.type === "remove_queue_item" &&
    typeof c.request_id === "string" &&
    isAgentRuntimeScope(c.runtime) &&
    typeof c.item_id === "string"
  );
}

export function isMonitorStopCommand(
  value: unknown,
): value is MonitorStopCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<MonitorStopCommand>;
  return (
    c.type === "monitor_stop" &&
    typeof c.request_id === "string" &&
    c.request_id.length > 0 &&
    isAgentRuntimeScope(c.runtime) &&
    c.runtime.agent_id.length > 0 &&
    c.runtime.conversation_id.length > 0 &&
    (c.runtime.acting_user_id === undefined ||
      typeof c.runtime.acting_user_id === "string") &&
    typeof c.process_id === "string" &&
    c.process_id.length > 0
  );
}
