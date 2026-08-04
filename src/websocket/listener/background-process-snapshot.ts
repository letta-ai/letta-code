import {
  type BackgroundProcess,
  type BackgroundRuntimeScope,
  type BackgroundTask,
  backgroundProcesses,
  backgroundTasks,
} from "@/tools/impl/process_manager";
import type { BackgroundProcessSummary } from "@/types/protocol_v2";

function belongsToRuntime(
  entry: BackgroundProcess | BackgroundTask,
  runtimeScope: BackgroundRuntimeScope,
): boolean {
  return (
    entry.runtimeScope?.agentId === runtimeScope.agentId &&
    entry.runtimeScope.conversationId === runtimeScope.conversationId
  );
}

export function buildBackgroundProcessSnapshot(
  agentId?: string | null,
  conversationId = "default",
): BackgroundProcessSummary[] {
  if (agentId === null) {
    return [];
  }
  const runtimeScope: BackgroundRuntimeScope | undefined =
    agentId === undefined ? undefined : { agentId, conversationId };
  const bashProcesses: BackgroundProcessSummary[] = Array.from(
    backgroundProcesses.entries(),
  )
    .filter(
      ([, proc]) =>
        proc.status === "running" &&
        (!runtimeScope || belongsToRuntime(proc, runtimeScope)),
    )
    .map(([processId, proc]) => ({
      process_id: processId,
      kind: "bash",
      command: proc.command,
      started_at_ms: proc.startTime?.getTime() ?? null,
      status: proc.status,
      exit_code: proc.exitCode,
    }));

  const taskProcesses: BackgroundProcessSummary[] = Array.from(
    backgroundTasks.entries(),
  )
    .filter(
      ([, task]) =>
        task.status === "running" &&
        (!runtimeScope || belongsToRuntime(task, runtimeScope)),
    )
    .map(([processId, task]) => ({
      process_id: processId,
      kind: "agent_task",
      task_type: task.displayType ?? task.subagentType,
      description: task.description,
      started_at_ms: task.startTime.getTime(),
      status: task.status,
      subagent_id: task.subagentId,
      ...(task.error ? { error: task.error } : {}),
    }));

  return [...bashProcesses, ...taskProcesses].sort((a, b) => {
    const aStart = a.started_at_ms ?? 0;
    const bStart = b.started_at_ms ?? 0;
    return bStart - aStart;
  });
}
