import { apiRequest } from "./request";

// The monitor resource is not yet included in the generated client.
export interface MonitorState {
  monitor_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  description: string;
  kind: "command" | "websocket" | "script" | "github_pull_request";
  command: string;
  status: "running" | "completed" | "failed";
  persistent: boolean;
  device_id: string | null;
  started_at: string | null;
  output_file: string | null;
  exit_code: number | null;
}

export function createMonitorState(
  input: Omit<MonitorState, "monitor_id">,
  actingUserId?: string | null,
): Promise<MonitorState> {
  return apiRequest("POST", "/v1/monitors", input, {
    actingUserId,
    signal: AbortSignal.timeout(15_000),
  });
}

export function updateMonitorState(
  id: string,
  input: Pick<MonitorState, "status" | "exit_code" | "output_file">,
  actingUserId?: string | null,
): Promise<MonitorState> {
  return apiRequest("PATCH", `/v1/monitors/${encodeURIComponent(id)}`, input, {
    actingUserId,
    signal: AbortSignal.timeout(15_000),
  });
}
