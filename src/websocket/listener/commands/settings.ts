import type WebSocket from "ws";
import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
} from "../../../cli/helpers/memoryReminder";
import { experimentManager } from "../../../experiments/manager";
import type {
  GetExperimentsCommand,
  GetExperimentsResponseMessage,
  GetReflectionSettingsCommand,
  ReflectionSettingsScope,
  SetExperimentCommand,
  SetExperimentResponseMessage,
  SetReflectionSettingsCommand,
} from "../../../types/protocol_v2";
import { getConversationWorkingDirectory } from "../cwd";
import {
  isGetExperimentsCommand,
  isGetReflectionSettingsCommand,
  isSetExperimentCommand,
  isSetReflectionSettingsCommand,
} from "../protocol-inbound";
import { emitDeviceStatusUpdate } from "../protocol-outbound";
import type { ListenerRuntime } from "../types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type ReflectionSettingsCommand =
  | GetReflectionSettingsCommand
  | SetReflectionSettingsCommand;

export type ExperimentCommand = GetExperimentsCommand | SetExperimentCommand;

type SettingsCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function toReflectionSettingsResponse(
  agentId: string,
  workingDirectory: string,
): {
  agent_id: string;
  trigger: "off" | "step-count" | "compaction-event";
  step_count: number;
} {
  const settings = getReflectionSettings(agentId, workingDirectory);
  return {
    agent_id: agentId,
    trigger: settings.trigger,
    step_count: settings.stepCount,
  };
}

function resolveReflectionSettingsScope(
  scope: ReflectionSettingsScope | undefined,
): {
  persistLocalProject: boolean;
  persistGlobal: boolean;
  normalizedScope: ReflectionSettingsScope;
} {
  if (scope === "local_project") {
    return {
      persistLocalProject: true,
      persistGlobal: false,
      normalizedScope: scope,
    };
  }
  if (scope === "global") {
    return {
      persistLocalProject: false,
      persistGlobal: true,
      normalizedScope: scope,
    };
  }
  return {
    persistLocalProject: true,
    persistGlobal: true,
    normalizedScope: "both",
  };
}

export async function handleExperimentCommand(
  parsed: ExperimentCommand,
  socket: WebSocket,
  listener: ListenerRuntime,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  if (parsed.type === "get_experiments") {
    const response: GetExperimentsResponseMessage = {
      type: "get_experiments_response",
      request_id: parsed.request_id,
      success: true,
      experiments: experimentManager.list(),
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );
    return true;
  }

  try {
    experimentManager.set(parsed.experiment_id, parsed.enabled);
    const response: SetExperimentResponseMessage = {
      type: "set_experiment_response",
      request_id: parsed.request_id,
      success: true,
      experiments: experimentManager.list(),
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );

    emitDeviceStatusUpdate(socket, listener);
  } catch (err) {
    const response: SetExperimentResponseMessage = {
      type: "set_experiment_response",
      request_id: parsed.request_id,
      success: false,
      experiments: experimentManager.list(),
      error: err instanceof Error ? err.message : "Failed to update experiment",
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );
  }

  return true;
}

export async function handleReflectionSettingsCommand(
  parsed: ReflectionSettingsCommand,
  socket: WebSocket,
  listener: ListenerRuntime,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const agentId = parsed.runtime.agent_id;
  const workingDirectory = getConversationWorkingDirectory(
    listener,
    parsed.runtime.agent_id,
    parsed.runtime.conversation_id,
  );

  if (parsed.type === "get_reflection_settings") {
    try {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: true,
          reflection_settings: toReflectionSettingsResponse(
            agentId,
            workingDirectory,
          ),
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: false,
          reflection_settings: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to load reflection settings",
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    }
    return true;
  }

  const { persistLocalProject, persistGlobal, normalizedScope } =
    resolveReflectionSettingsScope(parsed.scope);

  try {
    await persistReflectionSettingsForAgent(
      agentId,
      {
        trigger: parsed.settings.trigger,
        stepCount: parsed.settings.step_count,
      },
      {
        workingDirectory,
        persistLocalProject,
        persistGlobal,
      },
    );
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: true,
        scope: normalizedScope,
        reflection_settings: toReflectionSettingsResponse(
          agentId,
          workingDirectory,
        ),
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
    emitDeviceStatusUpdate(socket, listener, parsed.runtime);
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: false,
        scope: normalizedScope,
        reflection_settings: null,
        error:
          err instanceof Error
            ? err.message
            : "Failed to update reflection settings",
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
  }
  return true;
}

export function handleSettingsProtocolCommand(
  parsed: unknown,
  context: SettingsCommandContext,
): boolean {
  const { socket, runtime, safeSocketSend, runDetachedListenerTask } = context;

  if (isGetExperimentsCommand(parsed) || isSetExperimentCommand(parsed)) {
    runDetachedListenerTask("experiment_command", async () => {
      await handleExperimentCommand(parsed, socket, runtime, safeSocketSend);
    });
    return true;
  }

  if (
    isGetReflectionSettingsCommand(parsed) ||
    isSetReflectionSettingsCommand(parsed)
  ) {
    runDetachedListenerTask("reflection_settings_command", async () => {
      await handleReflectionSettingsCommand(
        parsed,
        socket,
        runtime,
        safeSocketSend,
      );
    });
    return true;
  }

  return false;
}
