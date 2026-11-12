import {
  createMonitorRecord,
  type MonitorFields,
  updateMonitorRecord,
} from "@/backend/api/monitors";
import { resolveCronRunnerForAgent } from "@/cron/runner";
import { getErrorMessage } from "@/utils/error";
import {
  type BackgroundProcess,
  backgroundProcesses,
  subscribeToBackgroundProcessState,
} from "./process_manager";

// Process handles remain local. Each queue captures the initiating identity so
// completion during another conversation cannot inherit that conversation's user.
interface PersistedMonitor {
  actingUserId: string | null | undefined;
  pending: Promise<void>;
  signature: string;
  unsubscribe: () => void;
}
const persisted = new Map<string, PersistedMonitor>();

export async function createMonitorState(
  fields: MonitorFields,
  scope: { agentId: string; conversationId: string } | undefined,
  actingUserId?: string | null,
): Promise<string | undefined> {
  const placement = await resolveCronRunnerForAgent(scope?.agentId ?? "");
  if ("error" in placement) throw new Error(placement.error);
  if (placement.runner === "local") return undefined;
  if (!scope)
    throw new Error(
      "Monitor needs an agent and conversation. Start it from a conversation.",
    );
  const record = await createMonitorRecord(
    {
      ...fields,
      device_id: placement.targetDeviceId ?? null,
      agent_id: scope.agentId,
      conversation_id: scope.conversationId,
    },
    actingUserId,
  ).catch((error: unknown) => {
    throw new Error(
      `Couldn't save the monitor: ${getErrorMessage(error)}. Retry.`,
    );
  });
  const state: PersistedMonitor = {
    actingUserId,
    pending: Promise.resolve(),
    signature: "",
    unsubscribe: () => {},
  };
  persisted.set(record.monitor_id, state);
  state.unsubscribe = subscribeToBackgroundProcessState(() => {
    const process = backgroundProcesses.get(record.monitor_id);
    if (process) syncMonitorState(record.monitor_id, process);
  });
  return record.monitor_id;
}

export function syncMonitorState(id: string, process: BackgroundProcess): void {
  const state = persisted.get(id);
  if (!state) return;
  const fields = {
    status: process.status,
    exit_code: process.exitCode,
    output_file: process.outputFile ?? null,
    started_at: process.startTime?.toISOString() ?? null,
  };
  const signature = JSON.stringify(fields);
  if (signature === state.signature) return;
  state.signature = signature;
  state.pending = state.pending
    .catch(() => {})
    .then(async () => {
      await updateMonitorRecord(id, fields, state.actingUserId);
      if (fields.status !== "running") persisted.delete(id);
    });
  // Background completion cannot throw into process callbacks. Explicit tool
  // operations await flushMonitorState, which surfaces persistence failures.
  void state.pending.catch((error: unknown) =>
    console.error("Monitor state update failed:", error),
  );
  if (process.status !== "running") state.unsubscribe();
}

export async function flushMonitorState(id: string): Promise<void> {
  const state = persisted.get(id);
  if (!state) return;
  const process = backgroundProcesses.get(id);
  try {
    await state.pending;
  } catch (error) {
    if (!process) throw error;
    state.signature = "";
    syncMonitorState(id, process);
    await state.pending;
  }
  if (!process || process.status !== "running") {
    state.unsubscribe();
    persisted.delete(id);
  }
}

export async function failMonitorState(id: string): Promise<void> {
  const state = persisted.get(id);
  if (!state) return;
  state.unsubscribe();
  await state.pending.catch(() => {});
  try {
    await updateMonitorRecord(id, { status: "failed" }, state.actingUserId);
  } finally {
    persisted.delete(id);
  }
}
