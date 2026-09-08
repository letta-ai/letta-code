import type {
  MonitorStopCommand,
  MonitorStopResponse,
} from "@/types/task-control-protocol";
import {
  getMonitorCancellationServices,
  pumpMonitorCancellations,
} from "@/websocket/listener/monitor-cancellation-delivery";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

export async function handleMonitorStopCommand(
  command: MonitorStopCommand,
  runtime: ListenerRuntime,
): Promise<MonitorStopResponse> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return {
      type: "monitor_stop_response",
      request_id: command.request_id,
      runtime: command.runtime,
      process_id: command.process_id,
      success: false,
      stopped: false,
      error: "Runtime is no longer active",
    };
  }
  const response = await getMonitorCancellationServices().stopper.stop(command);
  // Even a post-stop receipt-write failure may have left a recoverable intent.
  void pumpMonitorCancellations(runtime);
  return response;
}
