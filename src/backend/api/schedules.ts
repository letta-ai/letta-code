/**
 * Cloud schedules client (`/v1/agents/:agent_id/schedule` endpoints).
 *
 * These routes are served by the Letta API (cloud-api), not the OSS core
 * server. Cloud schedules are durable: the schedule definition lives in the
 * Letta API's database and fires from a cloud worker, which injects the
 * scheduled turn into the agent's managed cloud sandbox (`use_sandbox: true`)
 * or, when `target_device_id` is set, into that registered device's live
 * listener (if the device is offline at fire time, that occurrence fails with
 * TARGET_DEVICE_UNAVAILABLE; there is no sandbox fallback). Either way they
 * survive local process/device/sandbox termination, unlike runtime-local
 * crons in ~/.letta/crons.json.
 */

import { actingUserRequestOptions } from "@/agent/acting-user";
import { ApiRequestError, apiRequest } from "./request";

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
   * Railway/VPS listener). When the device is offline at fire time, that
   * occurrence fails (TARGET_DEVICE_UNAVAILABLE) and does not run.
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
  actingUserId?: string,
): Promise<CreateCloudScheduleResponse> {
  return apiRequest<CreateCloudScheduleResponse>(
    "POST",
    schedulePath(agentId),
    {
      ...input,
      // Cloud schedules created by the CLI always use harness delivery:
      // execution runs in the agent's managed sandbox, or on the device named
      // by `target_device_id` (LET-9821); offline device = failed occurrence.
      // The server requires use_sandbox for device targets either way.
      use_sandbox: true,
    },
    actingUserRequestOptions(actingUserId),
  );
}

export interface ListCloudSchedulesOptions {
  limit?: number;
  after?: string;
  name?: string;
  conversationId?: string;
}

export async function listCloudSchedules(
  agentId: string,
  options: ListCloudSchedulesOptions = {},
): Promise<ListCloudSchedulesResponse> {
  return apiRequest<ListCloudSchedulesResponse>(
    "GET",
    schedulePath(agentId),
    undefined,
    {
      query: {
        limit: options.limit ?? 100,
        after: options.after,
        name: options.name,
        conversation_id: options.conversationId,
      },
    },
  );
}

type ListCloudSchedulesRequest = typeof listCloudSchedules;

export interface ExactCloudScheduleFilter {
  name?: string;
  conversationId?: string;
}

function matchesExactFilter(
  schedule: CloudSchedule,
  filter: ExactCloudScheduleFilter,
): boolean {
  if (filter.name !== undefined && schedule.name !== filter.name) return false;
  if (filter.conversationId !== undefined) {
    const conversationId = schedule.conversation_id ?? "default";
    if (conversationId !== filter.conversationId) return false;
  }
  return true;
}

async function collectCloudSchedulePages(
  agentId: string,
  filter: ExactCloudScheduleFilter,
  request: ListCloudSchedulesRequest,
  sendFilter: boolean,
): Promise<{ schedules: CloudSchedule[]; filterWasHonored: boolean }> {
  const schedules: CloudSchedule[] = [];
  let after: string | undefined;
  do {
    const response = await request(agentId, {
      limit: 100,
      ...(after !== undefined && { after }),
      ...(sendFilter && filter.name !== undefined && { name: filter.name }),
      ...(sendFilter &&
        filter.conversationId !== undefined && {
          conversationId: filter.conversationId,
        }),
    });
    if (
      sendFilter &&
      response.scheduled_messages.some(
        (schedule) => !matchesExactFilter(schedule, filter),
      )
    ) {
      return { schedules: [], filterWasHonored: false };
    }
    schedules.push(
      ...response.scheduled_messages.filter((schedule) =>
        matchesExactFilter(schedule, filter),
      ),
    );
    after = response.has_next_page
      ? response.scheduled_messages.at(-1)?.id
      : undefined;
  } while (after);
  return { schedules, filterWasHonored: true };
}

function isUnsupportedFilterError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 400 || error.status === 422)
  );
}

/**
 * Lists every schedule matching exact predicates. New servers filter before
 * pagination; older servers safely fall back to the legacy unfiltered scan.
 */
export async function listCloudSchedulesByExactMatch(
  agentId: string,
  filter: ExactCloudScheduleFilter,
  request: ListCloudSchedulesRequest = listCloudSchedules,
): Promise<CloudSchedule[]> {
  // The API currently stores some default-conversation schedules as NULL. Until
  // the server defines how `conversation_id=default` treats those rows, retain
  // the legacy normalization so they cannot disappear from client lookups.
  const canUseFilter = filter.conversationId !== "default";
  if (canUseFilter) {
    try {
      const filtered = await collectCloudSchedulePages(
        agentId,
        filter,
        request,
        true,
      );
      if (filtered.filterWasHonored) return filtered.schedules;
    } catch (error) {
      if (!isUnsupportedFilterError(error)) throw error;
    }
  }

  return (await collectCloudSchedulePages(agentId, filter, request, false))
    .schedules;
}

export async function getCloudSchedule(
  agentId: string,
  scheduleId: string,
  actingUserId?: string,
): Promise<CloudSchedule> {
  return apiRequest<CloudSchedule>(
    "GET",
    `${schedulePath(agentId)}/${encodeURIComponent(scheduleId)}`,
    undefined,
    actingUserRequestOptions(actingUserId),
  );
}

export async function deleteCloudSchedule(
  agentId: string,
  scheduleId: string,
  actingUserId?: string,
): Promise<void> {
  await apiRequest<{ success: boolean }>(
    "DELETE",
    `${schedulePath(agentId)}/${encodeURIComponent(scheduleId)}`,
    {},
    actingUserRequestOptions(actingUserId),
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
