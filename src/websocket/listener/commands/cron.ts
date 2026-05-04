import type WebSocket from "ws";
import {
  addTask as addCronTask,
  deleteAllTasks as deleteAllCronTasks,
  deleteTask as deleteCronTask,
  getTask as getCronTask,
  listTasks as listCronTasks,
} from "../../../cron";
import type {
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
} from "../../../types/protocol_v2";
import {
  isCronAddCommand,
  isCronDeleteAllCommand,
  isCronDeleteCommand,
  isCronGetCommand,
  isCronListCommand,
} from "../protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type CronCommand =
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronDeleteCommand
  | CronDeleteAllCommand;

type CronCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function emitCronsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  scope?: { agent_id?: string; conversation_id?: string | null },
): void {
  safeSocketSend(
    socket,
    {
      type: "crons_updated",
      timestamp: Date.now(),
      ...(scope?.agent_id ? { agent_id: scope.agent_id } : {}),
      ...(scope?.conversation_id !== undefined
        ? { conversation_id: scope.conversation_id }
        : {}),
    },
    "listener_cron_send_failed",
    "listener_cron_command",
  );
}

export async function handleCronCommand(
  parsed: CronCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  if (parsed.type === "cron_list") {
    try {
      const tasks = listCronTasks({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks,
          success: true,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks: [],
          success: false,
          error: err instanceof Error ? err.message : "Failed to list crons",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_add") {
    try {
      const scheduledFor = parsed.scheduled_for
        ? new Date(parsed.scheduled_for)
        : undefined;
      if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
        throw new Error("Invalid scheduled_for timestamp");
      }
      const result = addCronTask({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
        name: parsed.name,
        description: parsed.description,
        cron: parsed.cron,
        timezone: parsed.timezone,
        recurring: parsed.recurring,
        prompt: parsed.prompt,
        scheduled_for: scheduledFor,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: true,
          task: result.task,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      emitCronsUpdated(socket, safeSocketSend, {
        agent_id: result.task.agent_id,
        conversation_id: result.task.conversation_id,
      });
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to add cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_get") {
    try {
      const task = getCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: true,
          found: task !== null,
          task,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          task: null,
          error: err instanceof Error ? err.message : "Failed to get cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_delete") {
    try {
      const existingTask = getCronTask(parsed.task_id);
      const found = deleteCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: true,
          found,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      if (found) {
        emitCronsUpdated(socket, safeSocketSend, {
          agent_id: existingTask?.agent_id,
          conversation_id: existingTask?.conversation_id,
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          error: err instanceof Error ? err.message : "Failed to delete cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  try {
    const deleted = deleteAllCronTasks(parsed.agent_id);
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: true,
        agent_id: parsed.agent_id,
        deleted,
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
    if (deleted > 0) {
      emitCronsUpdated(socket, safeSocketSend, {
        agent_id: parsed.agent_id,
      });
    }
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: false,
        agent_id: parsed.agent_id,
        deleted: 0,
        error: err instanceof Error ? err.message : "Failed to delete crons",
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
  }
  return true;
}

export function handleCronProtocolCommand(
  parsed: unknown,
  context: CronCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (
    isCronListCommand(parsed) ||
    isCronAddCommand(parsed) ||
    isCronGetCommand(parsed) ||
    isCronDeleteCommand(parsed) ||
    isCronDeleteAllCommand(parsed)
  ) {
    runDetachedListenerTask("cron_command", async () => {
      await handleCronCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  return false;
}
