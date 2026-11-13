import { actingUserRequestOptions } from "@/agent/acting-user";
import { ApiRequestError, apiRequest } from "@/backend/api/request";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getRuntimeActingUserAttribution } from "@/runtime-context";
import { resolveNotificationScope } from "@/utils/task-notifications.js";

export const CLOUD_MONITOR_MIN_INTERVAL_SECONDS = 60;
const DEFAULT_CLOUD_MONITOR_TIMEOUT_MS = 86_400_000;

/** Compared-value condition; every given test must hold. */
export interface CloudMonitorMatch {
  equals?: string[];
  contains?: string;
  gt?: number;
  lt?: number;
}

export interface CloudMonitorArgs {
  description: string;
  url: string;
  interval_seconds?: number;
  headers?: Record<string, string>;
  select?: string;
  match?: CloudMonitorMatch;
  stop_on_match?: boolean;
  timeout_ms?: number;
  toolCallId?: string;
  parentScope?: { agentId: string; conversationId: string };
}

export interface CloudMonitorResult {
  content: Array<{ type: "text"; text: string }>;
  taskId: string;
  timeoutMs: number;
  persistent: false;
}

type Request = typeof apiRequest;

export interface CloudMonitorDeps {
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

// Matches the forms Cloud fills: $NAME and ${NAME}.
const SECRET_REFERENCE = /\$(?:\{[A-Z_][A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*)/;
// Headers that carry credentials must reference a secret instead of holding
// one, so a raw token is never sent to or stored by Cloud.
const CREDENTIAL_HEADER = /auth|cookie|token|secret|key|password|session/i;

interface CloudUrlSource {
  type: "url";
  url: string;
  interval_seconds: number;
  headers?: Record<string, string>;
  select?: { type: "json"; path: string };
  notify_when?: { type: "match" } & CloudMonitorMatch;
  stop_on_match?: boolean;
}

function validateHeaders(headers: unknown): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    !Object.values(headers).every((value) => typeof value === "string")
  ) {
    throw new Error("CloudMonitor headers must map header names to strings");
  }
  const entries = Object.entries(headers as Record<string, string>);
  for (const [name, value] of entries) {
    if (CREDENTIAL_HEADER.test(name) && !SECRET_REFERENCE.test(value)) {
      throw new Error(
        `CloudMonitor header ${name} carries a credential, so its value must reference an agent secret ($NAME) instead of containing it`,
      );
    }
  }
  return entries.length > 0 ? (headers as Record<string, string>) : undefined;
}

function validateMatch(match: unknown): CloudMonitorMatch | undefined {
  if (match === undefined) return undefined;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    throw new Error("CloudMonitor match must be an object");
  }
  const { equals, contains, gt, lt } = match as CloudMonitorMatch;
  const result: CloudMonitorMatch = {};
  if (equals !== undefined) {
    if (!Array.isArray(equals) || !equals.every((v) => typeof v === "string")) {
      throw new Error("CloudMonitor match.equals must be an array of strings");
    }
    if (equals.length > 0) result.equals = equals;
  }
  if (contains !== undefined) {
    if (typeof contains !== "string" || contains === "") {
      throw new Error("CloudMonitor match.contains must be a non-empty string");
    }
    result.contains = contains;
  }
  for (const [key, value] of [
    ["gt", gt],
    ["lt", lt],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`CloudMonitor match.${key} must be a number`);
    }
    result[key] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      "CloudMonitor match needs at least one of equals, contains, gt or lt",
    );
  }
  return result;
}

/** The Cloud source for validated url arguments. */
function buildCloudSource(args: CloudMonitorArgs, url: string): CloudUrlSource {
  const source: CloudUrlSource = {
    type: "url",
    url,
    interval_seconds: args.interval_seconds ?? CLOUD_MONITOR_MIN_INTERVAL_SECONDS,
  };
  const headers = validateHeaders(args.headers);
  if (headers) source.headers = headers;
  if (args.select !== undefined) {
    if (
      typeof args.select !== "string" ||
      args.select.split(".").some((segment) => segment === "")
    ) {
      throw new Error(
        "CloudMonitor select must be a dot-separated path into the JSON response, such as 0.status",
      );
    }
    source.select = { type: "json", path: args.select };
  }
  const match = validateMatch(args.match);
  if (match) source.notify_when = { type: "match", ...match };
  if (args.stop_on_match !== undefined) {
    if (typeof args.stop_on_match !== "boolean") {
      throw new Error("CloudMonitor stop_on_match must be a boolean");
    }
    if (args.stop_on_match && !match) {
      throw new Error("CloudMonitor stop_on_match needs match");
    }
    if (args.stop_on_match) source.stop_on_match = true;
  }
  return source;
}

/** What the agent will be told, so it knows when to expect a notice. */
function notifyDescription(source: CloudUrlSource): string {
  const what = source.select
    ? `the value at ${source.select.path}`
    : "the HTTP status or body";
  if (!source.notify_when) {
    return `The first response is the baseline; you will be notified only when ${what} changes`;
  }
  const then = source.stop_on_match
    ? ", and then it stops"
    : "; it notifies again each time a match begins";
  return `You will be notified when ${what} first matches, including on the first poll${then}`;
}

function validateCloudMonitorArgs(args: CloudMonitorArgs): string {
  if (typeof args.description !== "string") {
    throw new Error("CloudMonitor description is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(String(args.url));
  } catch {
    throw new Error("CloudMonitor url must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CloudMonitor url must be an absolute http or https URL");
  }
  const interval = args.interval_seconds;
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < CLOUD_MONITOR_MIN_INTERVAL_SECONDS)
  ) {
    throw new Error(
      `CloudMonitor interval_seconds must be an integer of at least ${CLOUD_MONITOR_MIN_INTERVAL_SECONDS}`,
    );
  }
  if (
    args.timeout_ms !== undefined &&
    (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000)
  ) {
    throw new Error("CloudMonitor timeout_ms must be an integer of at least 1000");
  }
  return parsed.toString();
}

/**
 * CloudMonitor: registers a url monitor with Letta Cloud, which polls the URL
 * itself and notifies this conversation when the HTTP status or body changes.
 * Nothing runs locally: there is no background process, timer, or output file.
 */
export async function cloud_monitor(
  args: CloudMonitorArgs,
  deps: CloudMonitorDeps = {},
): Promise<CloudMonitorResult> {
  const url = validateCloudMonitorArgs(args);
  const source = buildCloudSource(args, url);
  if (!(deps.isCloud ?? isLettaCloud)()) {
    throw new Error(
      "CloudMonitor runs in Letta Cloud and is only available when connected to Letta Cloud. Use Monitor with a polling command instead.",
    );
  }
  const scope = resolveNotificationScope(args.parentScope);
  if (!scope) {
    throw new Error("CloudMonitor needs an agent conversation to notify");
  }
  if (!isSavedConversation(scope.conversationId)) {
    throw new Error(
      "CloudMonitor needs a saved conversation and is not available in the agent's default conversation. Use Monitor with a polling command instead.",
    );
  }
  const intervalSeconds = source.interval_seconds;
  const timeoutMs = args.timeout_ms ?? DEFAULT_CLOUD_MONITOR_TIMEOUT_MS;
  const request = deps.request ?? apiRequest;
  const created = await request<{ id: string }>(
    "POST",
    cloudMonitorsPath(scope.conversationId),
    {
      description: args.description,
      source,
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
        text: `Cloud monitor started (task ${taskId}, polls every ${intervalSeconds}s, timeout ${timeoutMs}ms). ${notifyDescription(source)}, even if this sandbox stops. Keep working — do not poll or sleep. Stop it with TaskStop.`,
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
  deps: CloudMonitorDeps = {},
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
