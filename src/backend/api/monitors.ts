import { apiRequest } from "./request";

export interface MonitorFields {
  description: string;
  kind: "command" | "websocket" | "script" | "github_pull_request";
  command: string;
  status: "running" | "completed" | "failed";
  persistent: boolean;
  device_id?: string | null;
  started_at?: string | null;
  output_file?: string | null;
  exit_code?: number | null;
}

export interface MonitorScope {
  agent_id: string;
  conversation_id: string;
}

export interface CloudMonitor extends MonitorFields {
  monitor_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export function createMonitorRecord(
  input: MonitorFields & MonitorScope,
  actingUserId?: string | null,
): Promise<CloudMonitor> {
  return apiRequest(
    "POST",
    "/v1/monitors",
    { ...input },
    { actingUserId, signal: AbortSignal.timeout(15_000) },
  );
}

export function updateMonitorRecord(
  id: string,
  input: Partial<MonitorFields>,
  actingUserId?: string | null,
): Promise<CloudMonitor> {
  return apiRequest(
    "PATCH",
    `/v1/monitors/${encodeURIComponent(id)}`,
    { ...input },
    { actingUserId, signal: AbortSignal.timeout(15_000) },
  );
}

export async function listMonitorRecords(
  scope: MonitorScope,
  actingUserId?: string | null,
): Promise<CloudMonitor[]> {
  const records: CloudMonitor[] = [];
  let after: string | undefined;
  do {
    const page = await apiRequest<CloudMonitor[]>(
      "GET",
      "/v1/monitors",
      undefined,
      {
        actingUserId,
        signal: AbortSignal.timeout(15_000),
        query: { ...scope, limit: 200, after },
      },
    );
    records.push(...page);
    after = page.length === 200 ? page.at(-1)?.monitor_id : undefined;
  } while (after);
  return records;
}

export async function deleteMonitorRecord(
  id: string,
  actingUserId?: string | null,
): Promise<void> {
  await apiRequest(
    "DELETE",
    `/v1/monitors/${encodeURIComponent(id)}`,
    undefined,
    { actingUserId, signal: AbortSignal.timeout(15_000) },
  );
}
