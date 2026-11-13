import { ApiRequestError, apiRequest } from "./request";

// The monitor resource is not yet included in the generated client.
export interface MonitorState {
  monitor_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  description: string;
  kind: "command" | "websocket" | "script" | "github_pull_request";
  command: string;
  status: "running" | "paused" | "completed" | "failed" | "expired" | "stopped";
  persistent: boolean;
  device_id: string | null;
  started_at: string | null;
  output_file: string | null;
  exit_code: number | null;
  expires_at?: string | null;
  args?: Record<string, unknown>;
}

export async function createMonitorState(
  input: Omit<MonitorState, "monitor_id">,
  actingUserId?: string | null,
): Promise<MonitorState> {
  try {
    return await apiRequest("POST", "/v1/monitors", input, {
      actingUserId,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      error.status !== 400 ||
      !error.responseText.includes("Invalid request")
    )
      throw error;
    // Older servers validate strict request bodies and reject lifecycle fields.
    const { args: _args, expires_at: _expires, ...legacy } = input;
    return apiRequest("POST", "/v1/monitors", legacy, {
      actingUserId,
      signal: AbortSignal.timeout(15_000),
    });
  }
}

export async function updateMonitorState(
  id: string,
  input: Pick<MonitorState, "status" | "exit_code" | "output_file"> &
    Partial<Pick<MonitorState, "device_id">>,
  actingUserId?: string | null,
): Promise<MonitorState> {
  const path = `/v1/monitors/${encodeURIComponent(id)}`;
  try {
    return await apiRequest("PATCH", path, input, {
      actingUserId,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      error.status !== 400 ||
      !error.responseText.includes("Invalid request") ||
      !["expired", "stopped", "paused"].includes(input.status)
    )
      throw error;
    return apiRequest(
      "PATCH",
      path,
      { ...input, status: "failed" },
      { actingUserId, signal: AbortSignal.timeout(15_000) },
    );
  }
}

export async function retrieveMonitorState(id: string): Promise<MonitorState> {
  try {
    return await apiRequest(
      "GET",
      `/v1/monitors/${encodeURIComponent(id)}`,
      undefined,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404)
      throw new Error(
        `Monitor ${id} was not found or this server does not support monitor resume.`,
      );
    throw error;
  }
}

export function listMonitorStates(scope: {
  agent_id?: string;
  conversation_id?: string;
  status?: string;
  after?: string;
}): Promise<MonitorState[]> {
  return apiRequest("GET", "/v1/monitors", undefined, {
    query: { ...scope, limit: 200 },
    signal: AbortSignal.timeout(15_000),
  });
}
