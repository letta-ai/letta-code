/**
 * Cloud schedules client (`/v1/agents/:agent_id/schedule` endpoints).
 *
 * These routes are served by the Letta API (cloud-api), not the OSS core
 * server. Cloud schedules are durable: the schedule definition lives in the
 * Letta API's database and fires from a cloud worker, which injects the
 * scheduled turn into the agent's managed cloud sandbox (`use_sandbox: true`).
 * They survive local process/device/sandbox termination, unlike runtime-local
 * crons in ~/.letta/crons.json.
 */

import { apiRequest } from "./request";

// ── Wire types (mirror the cloud scheduledMessages contract) ────────

export type CloudScheduleSpec =
  | { type: "recurring"; cron_expression: string }
  | { type: "one-time"; scheduled_at: number };

export interface CloudScheduleMessage {
  role: string;
  content: unknown;
}

export interface CreateCloudScheduleInput {
  name: string;
  description: string;
  conversation_id?: string;
  messages: CloudScheduleMessage[];
  schedule: CloudScheduleSpec;
  /**
   * Optional execution target: a registered environment deviceId (e.g. a
   * Railway/VPS listener). When the device is offline at fire time, the
   * cloud worker falls back to the agent's managed sandbox.
   */
  target_device_id?: string;
}

export interface CreateCloudScheduleResponse {
  id: string;
  next_scheduled_at?: string;
  use_sandbox: boolean;
  target_device_id?: string | null;
}

export interface CloudSchedule {
  id: string;
  agent_id: string;
  name?: string | null;
  description?: string | null;
  conversation_id?: string | null;
  message: { messages?: CloudScheduleMessage[] } & Record<string, unknown>;
  schedule: CloudScheduleSpec;
  next_scheduled_time: string | null;
  use_sandbox: boolean;
  target_device_id?: string | null;
  created_at?: string;
}

export interface ListCloudSchedulesResponse {
  scheduled_messages: CloudSchedule[];
  has_next_page: boolean;
}

export interface CloudScheduleHistoryEntry {
  id: string;
  scheduled_message_id: string;
  status: "success" | "failed";
  response: Record<string, unknown> | null;
  run_id: string | null;
  sent_at: string;
}

export interface ListCloudScheduleHistoryResponse {
  history: CloudScheduleHistoryEntry[];
  has_next_page: boolean;
  next_offset: number | null;
}

// ── Requests ────────────────────────────────────────────────────────

function schedulePath(agentId: string): string {
  return `/v1/agents/${encodeURIComponent(agentId)}/schedule`;
}

export async function createCloudSchedule(
  agentId: string,
  input: CreateCloudScheduleInput,
): Promise<CreateCloudScheduleResponse> {
  return apiRequest<CreateCloudScheduleResponse>(
    "POST",
    schedulePath(agentId),
    {
      ...input,
      // The only harness-capable execution target the cloud worker supports
      // today is the agent's own managed sandbox. Named remote targets are
      // future work (LET-9821).
      use_sandbox: true,
    },
  );
}

export async function listCloudSchedules(
  agentId: string,
  options: { limit?: number; after?: string } = {},
): Promise<ListCloudSchedulesResponse> {
  return apiRequest<ListCloudSchedulesResponse>(
    "GET",
    schedulePath(agentId),
    undefined,
    {
      query: {
        limit: options.limit ?? 100,
        after: options.after,
      },
    },
  );
}

export async function getCloudSchedule(
  agentId: string,
  scheduleId: string,
): Promise<CloudSchedule> {
  return apiRequest<CloudSchedule>(
    "GET",
    `${schedulePath(agentId)}/${encodeURIComponent(scheduleId)}`,
  );
}

export async function deleteCloudSchedule(
  agentId: string,
  scheduleId: string,
): Promise<void> {
  await apiRequest<{ success: boolean }>(
    "DELETE",
    `${schedulePath(agentId)}/${encodeURIComponent(scheduleId)}`,
    {},
  );
}

export async function listCloudScheduleHistory(
  agentId: string,
  scheduleId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ListCloudScheduleHistoryResponse> {
  return apiRequest<ListCloudScheduleHistoryResponse>(
    "GET",
    `${schedulePath(agentId)}/${encodeURIComponent(scheduleId)}/history`,
    undefined,
    {
      query: {
        limit: options.limit,
        offset: options.offset,
      },
    },
  );
}
