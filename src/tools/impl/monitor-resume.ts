import {
  retrieveMonitorState,
  updateMonitorState,
} from "@/backend/api/monitors";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getRuntimeContext } from "@/runtime-context";
import { resolveNotificationScope } from "@/utils/task-notifications";
import type { MonitorArgs } from "./monitor-args";

export async function readResumableMonitor(
  id: string,
  parentScope?: { agentId: string; conversationId: string },
) {
  if (resolveBackendMode() === "local")
    throw new Error("Saved monitor resume requires the API backend.");
  const record = await retrieveMonitorState(id);
  const runtime = getRuntimeContext();
  const scope =
    runtime?.agentId === null && runtime.conversationId
      ? { agentId: null, conversationId: runtime.conversationId }
      : resolveNotificationScope(parentScope);
  if (
    scope &&
    (record.agent_id !== scope.agentId ||
      (record.conversation_id ?? "default") !== scope.conversationId)
  )
    throw new Error("Resume the monitor in its original conversation.");
  if (record.status === "expired")
    throw new Error(`Monitor ${id} has expired; start a new monitor instead.`);
  if (record.status !== "paused")
    throw new Error(
      `Monitor ${id} is ${record.status}; only paused monitors can resume.`,
    );
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    await updateMonitorState(id, {
      status: "expired",
      exit_code: null,
      output_file: record.output_file,
    });
    throw new Error(`Monitor ${id} has expired; start a new monitor instead.`);
  }
  if (!record.args || !Object.keys(record.args).length)
    throw new Error(
      `Monitor ${id} has no saved tool arguments; start a new monitor instead.`,
    );
  return record;
}

export function savedMonitorArgs(input: MonitorArgs): Record<string, unknown> {
  const omitted = new Set([
    "parentScope",
    "signal",
    "secretEnv",
    "variableEnv",
    "toolCallId",
    "resume",
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !omitted.has(key)),
  );
}
