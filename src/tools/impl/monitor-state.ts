import { createMonitorState, updateMonitorState } from "@/backend/api/monitors";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  getRuntimeActingUserAttribution,
  getRuntimeContext,
} from "@/runtime-context";
import {
  captureSecretRedactions,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import { resolveNotificationScope } from "@/utils/task-notifications";
import {
  type BackgroundProcess,
  backgroundProcesses,
  getNextMonitorId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager";

/** Persist metadata, not process handles: execution still belongs to this host. */
export async function withMonitorState<T>(
  input: {
    description: string;
    command: string;
    kind: NonNullable<BackgroundProcess["monitorSource"]>;
    persistent: boolean;
    parentScope?: { agentId: string; conversationId: string };
    signal?: AbortSignal;
    secretEnv?: Record<string, string>;
  },
  start: (id: string) => T | Promise<T>,
): Promise<T> {
  if (resolveBackendMode() === "local") return start(getNextMonitorId());
  const runtime = getRuntimeContext();
  const scope =
    !input.parentScope && runtime?.agentId === null && runtime.conversationId
      ? { agentId: null, conversationId: runtime.conversationId }
      : resolveNotificationScope(input.parentScope);
  if (!scope)
    throw new Error("A conversation is required to start a cloud monitor");
  const actingUserId = getRuntimeActingUserAttribution();
  const secrets = {
    ...captureSecretRedactions(scope.agentId ?? undefined),
    ...input.secretEnv,
  };
  const record = await createMonitorState(
    {
      agent_id: scope.agentId || null,
      conversation_id: scope.conversationId,
      description: scrubSecretsFromString(input.description, secrets),
      command: scrubSecretsFromString(input.command, secrets),
      kind: input.kind,
      persistent: input.persistent,
      status: "running",
      device_id: getRuntimeContext()?.environmentDeviceId ?? null,
      started_at: new Date().toISOString(),
      output_file: null,
      exit_code: null,
    },
    actingUserId,
  );
  const id = record.monitor_id;
  try {
    input.signal?.throwIfAborted();
    const result = await start(id);
    const process = backgroundProcesses.get(id);
    if (!process) throw new Error("Monitor did not register its process");
    let pending = Promise.resolve();
    process.persistState = () => {
      const state = {
        status: process.status,
        exit_code: process.exitCode,
        output_file: process.outputFile ?? null,
      };
      pending = pending
        .catch(() => {})
        .then(async () => {
          await updateMonitorState(id, state, actingUserId);
        });
      return pending;
    };
    await process.persistState();
    return result;
  } catch (error) {
    const process = backgroundProcesses.get(id);
    if (process) {
      process.completionNotificationSuppressed = true;
      process.status = "failed";
      process.process.kill("SIGTERM");
      notifyBackgroundProcessStateChanged(process.runtimeScope);
      scheduleBackgroundProcessCleanup(id);
    }
    await updateMonitorState(
      id,
      {
        status: "failed",
        exit_code: null,
        output_file: process?.outputFile ?? null,
      },
      actingUserId,
    );
    throw error;
  }
}

export async function persistMonitorState(
  process: BackgroundProcess,
): Promise<void> {
  await process.persistState?.().catch((error: unknown) => {
    console.error("Failed to persist monitor state:", error);
  });
}
