import { actingUserRequestOptions } from "@/agent/acting-user";
import { ApiRequestError, apiRequest } from "@/backend/api/request";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getRuntimeActingUserAttribution } from "@/runtime-context";
import { resolveNotificationScope } from "@/utils/task-notifications.js";

export const URL_MONITOR_MIN_INTERVAL_SECONDS = 60;
const DEFAULT_URL_MONITOR_TIMEOUT_MS = 86_400_000;

export interface UrlMonitorArgs {
  description: string;
  url?: string;
  interval_seconds?: number;
  timeout_ms?: number;
  persistent?: boolean;
  command?: string;
  ws?: { url: string };
  script?: string;
  backup_after_seconds?: number;
  backup_prompt?: string;
  toolCallId?: string;
  parentScope?: { agentId: string; conversationId: string };
}

export interface UrlMonitorResult {
  content: Array<{ type: "text"; text: string }>;
  taskId: string;
  timeoutMs: number;
  persistent: false;
}

type Request = typeof apiRequest;

export interface CloudUrlMonitorDeps {
  isCloud?: () => boolean;
  request?: Request;
  /** The conversation TaskStop runs in. */
  scope?: () => { conversationId: string } | undefined;
}

function isLettaCloud(): boolean {
  return resolveBackendMode() === "api" && isCloudServerUrl();
}

/** Cloud monitor ids are `cmon-…`; local monitor ids are `monitor_<uuid>`. */
export function isCloudMonitorId(taskId: string): boolean {
  return taskId.startsWith("cmon-");
}

function cloudMonitorsPath(conversationId: string): string {
  return `/v1/conversations/${encodeURIComponent(conversationId)}/cloud-monitors`;
}

/** The default conversation has no conversation id Cloud can scope to. */
function isSavedConversation(conversationId: string): boolean {
  return conversationId !== "" && conversationId !== "default";
}

function validateUrlMonitorArgs(args: UrlMonitorArgs): string {
  if (typeof args.description !== "string") {
    throw new Error("Monitor description is required");
  }
  // Empty unused source fields count as absent, as for the local sources.
  const otherSource =
    (typeof args.command === "string" && args.command.length > 0) ||
    (typeof args.script === "string" && args.script.trim() !== "") ||
    (args.ws !== undefined && args.ws?.url !== "");
  if (otherSource) {
    throw new Error(
      "Monitor requires exactly one of command, ws, or script, or url",
    );
  }
  if (args.persistent) {
    throw new Error(
      "Monitor url does not support persistent; set timeout_ms instead",
    );
  }
  if (
    args.backup_after_seconds !== undefined ||
    args.backup_prompt !== undefined
  ) {
    throw new Error(
      "Monitor url does not support backup_after_seconds or backup_prompt",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(String(args.url));
  } catch {
    throw new Error("Monitor url must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Monitor url must be an absolute http or https URL");
  }
  const interval = args.interval_seconds;
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < URL_MONITOR_MIN_INTERVAL_SECONDS)
  ) {
    throw new Error(
      `Monitor interval_seconds must be an integer of at least ${URL_MONITOR_MIN_INTERVAL_SECONDS}`,
    );
  }
  if (
    args.timeout_ms !== undefined &&
    (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000)
  ) {
    throw new Error("Monitor timeout_ms must be an integer of at least 1000");
  }
  return parsed.toString();
}

/**
 * Registers a url monitor with Letta Cloud, which polls the URL itself and
 * notifies this conversation when the HTTP status or body changes. Nothing
 * runs locally: there is no background process, timer, or output file.
 */
export async function startCloudUrlMonitor(
  args: UrlMonitorArgs,
  deps: CloudUrlMonitorDeps = {},
): Promise<UrlMonitorResult> {
  const url = validateUrlMonitorArgs(args);
  if (!(deps.isCloud ?? isLettaCloud)()) {
    throw new Error(
      "Monitor url runs in Letta Cloud and is only available when connected to Letta Cloud. Use command with a polling loop instead.",
    );
  }
  const scope = resolveNotificationScope(args.parentScope);
  if (!scope) {
    throw new Error("Monitor url needs an agent conversation to notify");
  }
  if (!isSavedConversation(scope.conversationId)) {
    throw new Error(
      "Monitor url needs a saved conversation and is not available in the agent's default conversation. Use command with a polling loop instead.",
    );
  }
  const intervalSeconds =
    args.interval_seconds ?? URL_MONITOR_MIN_INTERVAL_SECONDS;
  const timeoutMs = args.timeout_ms ?? DEFAULT_URL_MONITOR_TIMEOUT_MS;
  const request = deps.request ?? apiRequest;
  const created = await request<{ id: string }>(
    "POST",
    cloudMonitorsPath(scope.conversationId),
    {
      description: args.description,
      source: { type: "url", url, interval_seconds: intervalSeconds },
      timeout_ms: timeoutMs,
      ...(args.toolCallId && { tool_call_id: args.toolCallId }),
    },
    actingUserRequestOptions(scope.actingUserId),
  );
  const taskId = created.id;
  return {
    content: [
      {
        type: "text",
        text: `Cloud monitor started (task ${taskId}, polls every ${intervalSeconds}s, timeout ${timeoutMs}ms). The first response is the baseline; you will be notified only when the HTTP status or body changes, even if this sandbox stops. Keep working — do not poll or sleep. Stop it with TaskStop.`,
      },
    ],
    taskId,
    timeoutMs,
    persistent: false,
  };
}

/**
 * TaskStop for a Cloud monitor: deletes it, which stops its polling. Cloud
 * monitors belong to a conversation, so this stops one started in the
 * current conversation.
 */
export async function stopCloudUrlMonitor(
  taskId: string,
  deps: CloudUrlMonitorDeps = {},
): Promise<{ killed: boolean; output: string }> {
  if (!(deps.isCloud ?? isLettaCloud)()) {
    return {
      killed: false,
      output: `No task ${taskId} is running here, and Cloud monitors can only be stopped when connected to Letta Cloud.`,
    };
  }
  const conversationId = (deps.scope ?? resolveNotificationScope)()
    ?.conversationId;
  if (!conversationId || !isSavedConversation(conversationId)) {
    return {
      killed: false,
      output: `No Cloud monitor ${taskId} was found in this conversation.`,
    };
  }
  const request = deps.request ?? apiRequest;
  let stopped: { status: string };
  try {
    stopped = await request<{ status: string }>(
      "DELETE",
      `${cloudMonitorsPath(conversationId)}/${encodeURIComponent(taskId)}`,
      undefined,
      actingUserRequestOptions(getRuntimeActingUserAttribution()),
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return {
        killed: false,
        output: `No Cloud monitor ${taskId} was found in this conversation.`,
      };
    }
    throw error;
  }
  // A monitor that had already ended keeps and reports its final status.
  if (stopped.status !== "cancelled") {
    return {
      killed: false,
      output: `Cloud monitor ${taskId} had already stopped (${stopped.status}).`,
    };
  }
  return { killed: true, output: `Stopped Cloud monitor ${taskId}.` };
}
