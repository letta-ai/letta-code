import { stopMonitor } from "@/tools/impl/stop-monitor";
import type {
  MonitorStopCommand,
  MonitorStopResponse,
} from "@/types/task-control-protocol";
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
  return stopMonitor(command);
}
