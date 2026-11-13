import {
  createMonitorState,
  type MonitorState,
  updateMonitorState,
} from "@/backend/api/monitors";
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
    args?: Record<string, unknown>;
    timeoutMs?: number;
    resumeRecord?: MonitorState;
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
  const startedAt = new Date().toISOString();
  const record =
    input.resumeRecord ??
    (await createMonitorState(
      {
        agent_id: scope.agentId || null,
        conversation_id: scope.conversationId,
        description: scrubSecretsFromString(input.description, secrets),
        command: scrubSecretsFromString(input.command, secrets),
        kind: input.kind,
        persistent: input.persistent,
        status: "running",
        device_id: getRuntimeContext()?.environmentDeviceId ?? null,
        started_at: startedAt,
        expires_at: input.timeoutMs
          ? new Date(Date.now() + input.timeoutMs).toISOString()
          : null,
        // Credentials and execution context never belong in durable tool args.
        args: JSON.parse(
          JSON.stringify(input.args ?? {}, (_key, value) =>
            typeof value === "string"
              ? scrubSecretsFromString(value, secrets)
              : value,
          ),
        ),
        output_file: null,
        exit_code: null,
      },
      actingUserId,
    ));
  const id = record.monitor_id;
  if (backgroundProcesses.get(id)?.status === "running")
    throw new Error(`Monitor ${id} is already running on this host`);
  try {
    if (input.resumeRecord) {
      await updateMonitorState(
        id,
        {
          status: "running",
          exit_code: null,
          output_file: record.output_file,
          device_id:
            getRuntimeContext()?.environmentDeviceId ?? record.device_id,
        },
        actingUserId,
      );
    }
    input.signal?.throwIfAborted();
    const result = await start(id);
    const process = backgroundProcesses.get(id);
    if (!process) throw new Error("Monitor did not register its process");
    let pending = Promise.resolve();
    process.persistState = () => {
      let status = process.monitorEndStatus ?? process.status;
      // A strict legacy create response has no saved-args capability.
      if (
        record.args === undefined &&
        ["expired", "stopped", "paused"].includes(status)
      )
        status = "failed";
      const state = {
        status,
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
    ).catch((persistenceError: unknown) => {
      console.error("Failed to persist monitor state:", persistenceError);
    });
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
