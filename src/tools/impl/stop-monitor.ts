import { randomUUID } from "node:crypto";
import type {
  MonitorStopCommand,
  MonitorStopResponse,
} from "@/types/task-control-protocol";
import { kill_bash } from "./kill-bash";
import type { MonitorCancellationStore } from "./monitor-cancellation-store";
import { backgroundProcesses } from "./process_manager";

export class UserMonitorStopper {
  private readonly pending = new Map<string, Promise<MonitorStopResponse>>();
  constructor(private readonly store: MonitorCancellationStore) {}

  async stop(command: MonitorStopCommand): Promise<MonitorStopResponse> {
    const previous = this.pending.get(command.process_id);
    if (previous) {
      await previous;
      return this.stop(command);
    }
    const operation = this.perform(command);
    this.pending.set(command.process_id, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(command.process_id);
    }
  }

  private async perform(
    command: MonitorStopCommand,
  ): Promise<MonitorStopResponse> {
    const response: MonitorStopResponse = {
      type: "monitor_stop_response",
      request_id: command.request_id,
      runtime: command.runtime,
      process_id: command.process_id,
      success: false,
      stopped: false,
    };
    try {
      const receipt = this.store.read(command.process_id);
      if (
        receipt &&
        (receipt.runtime.agent_id !== command.runtime.agent_id ||
          receipt.runtime.conversation_id !== command.runtime.conversation_id)
      ) {
        throw new Error("Monitor does not belong to this conversation");
      }
      if (
        receipt &&
        ["stopped", "uncertain", "delivered"].includes(receipt.state)
      ) {
        return { ...response, success: true };
      }
      const process = backgroundProcesses.get(command.process_id);
      if (!process || process.kind !== "monitor")
        throw new Error("Monitor not found");
      if (
        process.runtimeScope?.agentId !== command.runtime.agent_id ||
        process.runtimeScope.conversationId !== command.runtime.conversation_id
      ) {
        throw new Error("Monitor does not belong to this conversation");
      }
      if (process.status !== "running") return { ...response, success: true };
      const intent = {
        version: 1 as const,
        processId: command.process_id,
        noticeId: receipt?.noticeId ?? randomUUID(),
        runtime: { ...command.runtime },
        description: process.description ?? command.process_id,
        state: "intent" as const,
        createdAt: receipt?.createdAt ?? Date.now(),
        creatorPid: globalThis.process.pid,
      };
      // A failed write must leave the running Monitor untouched.
      this.store.write(intent);
      const result = await kill_bash({ shell_id: command.process_id });
      if (!result.killed) {
        this.store.write({ ...intent, state: "failed" });
        throw new Error("Monitor could not be stopped");
      }
      response.stopped = true;
      this.store.write({ ...intent, state: "stopped" });
      return { ...response, success: true };
    } catch (error) {
      return {
        ...response,
        error:
          error instanceof Error
            ? error.message
            : "Monitor cancellation failed",
      };
    }
  }
}
