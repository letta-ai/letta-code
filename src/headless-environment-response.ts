import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message as LettaMessage } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { Backend } from "@/backend";
import {
  type AgentRuntimeStatusEntry,
  type AgentRuntimeStatusSnapshot,
  getAgentRuntimeStatus,
} from "@/backend/api/agents";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import {
  type AgentSandboxOptions,
  type EnvironmentConnection,
  getEnvironmentConnection,
  isEnvironmentOnline,
  resolveAgentSandboxConnectionId,
  resolveEnvironmentConnectionId,
  type SendEnvironmentMessageBody,
  SUBAGENT_CLOUD_OPTIONS_ENV,
} from "@/backend/api/environments";
import { ApiRequestError } from "@/backend/api/request";
import { toolFilter } from "@/tools/filter";
import type { ResultMessage, UsageStatistics } from "@/types/protocol";

export type ListenerLaunchResult =
  | {
      status: "completed";
      text: string;
      stopReason: StopReasonType | null;
      runIds: string[];
      usage: UsageStatistics;
    }
  | { status: "queued"; receipt: EnqueueReceipt };

export type ReplyEnvironmentMetadata =
  | {
      source: "same-environment";
    }
  | {
      source: "explicit" | "cloud-sandbox";
      input: string;
      id: string;
      connection_id: string;
      device_id: string;
      name: string;
    };

export function buildEnvironmentResponseMetadata(params: {
  source: Extract<
    ReplyEnvironmentMetadata,
    { source: "explicit" | "cloud-sandbox" }
  >["source"];
  input: string;
  connectionId: string;
  environment: EnvironmentConnection;
}): ReplyEnvironmentMetadata {
  return {
    source: params.source,
    input: params.input,
    id: params.environment.id,
    connection_id: params.connectionId,
    device_id: params.environment.deviceId,
    name: params.environment.connectionName,
  };
}

export function buildEnvironmentLaunchResult(
  base: {
    sessionId: string;
    agentId: string | null;
    internalAgentId: string;
    conversationId: string;
    environment: ReplyEnvironmentMetadata;
    durationMs: number;
    durationApiMs: number;
  },
  outcome: ListenerLaunchResult | { status: "error"; error: string },
): ResultMessage & {
  is_error: boolean;
  environment: ReplyEnvironmentMetadata;
} {
  const reply = outcome.status === "completed" ? outcome : null;
  return {
    type: "result",
    subtype: outcome.status === "completed" ? "success" : outcome.status,
    is_error: outcome.status === "error",
    result: reply?.text ?? null,
    session_id: base.sessionId,
    duration_ms: base.durationMs,
    duration_api_ms: base.durationApiMs,
    num_turns: reply?.usage.step_count ?? reply?.runIds.length ?? 0,
    agent_id: base.agentId,
    conversation_id: base.conversationId,
    environment: base.environment,
    run_ids: reply?.runIds ?? [],
    usage: reply?.usage ?? null,
    uuid: `result-${base.internalAgentId}-${Date.now()}`,
    ...(outcome.status === "queued" ? outcome.receipt : {}),
    ...(outcome.status === "error"
      ? { error: outcome.error, stop_reason: "error" as const }
      : {}),
    ...(reply?.stopReason && reply.stopReason !== "end_turn"
      ? { stop_reason: reply.stopReason }
      : {}),
  };
}

export function takeSubagentCloudOptions(): string | undefined {
  const json = process.env[SUBAGENT_CLOUD_OPTIONS_ENV];
  delete process.env[SUBAGENT_CLOUD_OPTIONS_ENV];
  return json;
}

export function isCloudEnvironmentSelector(
  selector: string | boolean | undefined,
): boolean {
  if (typeof selector !== "string") return false;
  const normalized = selector.trim().toLowerCase();
  return normalized === "cloud" || normalized === "cloud-sandbox";
}

type EnvironmentRouting = {
  connectionId: string;
  environment: EnvironmentConnection;
};

export async function resolveListenerLaunchTarget(input: {
  selector: string;
  agentId: string | null | undefined;
  conversationId: string;
  inheritedConnectionId?: string | null;
  sandboxOptionsJson?: string;
  resolveComputer?: (selector: string) => Promise<EnvironmentRouting>;
  resolveCloudSandbox?: (
    agentId: string,
    options: AgentSandboxOptions & { conversationId: string },
  ) => Promise<EnvironmentRouting>;
}): Promise<
  | {
      connectionId: string;
      responseEnvironment: ReplyEnvironmentMetadata;
      cloudSkillRepositories?: string[];
    }
  | { error: string }
> {
  const { selector, agentId } = input;
  if (!agentId)
    return {
      error:
        "Listener delivery requires a conversation with an agent or parent agent.",
    };
  const useCloudSandbox = isCloudEnvironmentSelector(selector);
  let routing: EnvironmentRouting | null = null;
  let sandboxOptions: AgentSandboxOptions | undefined;
  try {
    if (useCloudSandbox && input.sandboxOptionsJson) {
      sandboxOptions = JSON.parse(input.sandboxOptionsJson);
    }
    if (selector)
      routing = useCloudSandbox
        ? await (input.resolveCloudSandbox ?? resolveAgentSandboxConnectionId)(
            agentId,
            {
              ...sandboxOptions,
              conversationId: input.conversationId,
            },
          )
        : await (input.resolveComputer ?? resolveEnvironmentConnectionId)(
            selector,
          );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const connectionId = routing?.connectionId ?? input.inheritedConnectionId;
  if (!connectionId)
    return { error: "No listener connection was resolved for this launch" };
  return {
    connectionId,
    ...(sandboxOptions?.githubRepositories?.length && {
      cloudSkillRepositories: sandboxOptions.githubRepositories.map(
        ({ repo }) => repo,
      ),
    }),
    responseEnvironment: routing
      ? buildEnvironmentResponseMetadata({
          source: useCloudSandbox ? "cloud-sandbox" : "explicit",
          input: selector,
          connectionId,
          environment: routing.environment,
        })
      : { source: "same-environment" },
  };
}

export function getEnvironmentRoutedMessagingUnsupportedReason(
  environment: EnvironmentConnection,
): string | null {
  if (environment.metadata?.environmentMessageProtocol === "v2-input")
    return null;
  return `Computer ${environment.connectionName} (${environment.deviceId}) is running Letta Code ${
    environment.metadata?.lettaCodeVersion ?? "unknown"
  } and does not advertise computer-routed headless messaging support. Update that runtime or omit --computer to use same-computer messaging.`;
}

export function buildEnvironmentCreateMessageBody(params: {
  agentId: string;
  conversationId: string | null;
  content: MessageCreate["content"];
  otid: string;
}): SendEnvironmentMessageBody {
  const clientToolAllowlist = toolFilter.getEnabledTools();
  return {
    agentId: params.agentId,
    conversationId: params.conversationId,
    ...(clientToolAllowlist !== null
      ? { client_tool_allowlist: clientToolAllowlist }
      : {}),
    messages: [
      {
        role: "user",
        content: params.content,
        client_message_id: randomUUID(),
        otid: params.otid,
      },
    ],
  };
}

function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) {
      return maybePage.items;
    }
  }
  return [];
}

function extractMessageText(message: LettaMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isAssistantMessage(message: LettaMessage): boolean {
  return (
    (message as { message_type?: string }).message_type === "assistant_message"
  );
}

function isUserMessage(message: LettaMessage): boolean {
  return (message as { message_type?: string }).message_type === "user_message";
}

function isTaskNotificationMessage(message: LettaMessage): boolean {
  return extractMessageText(message)
    .trimStart()
    .startsWith("<task-notification>");
}

function messageRunId(message: LettaMessage | undefined): string | null {
  if (!message) return null;
  const runId = (message as { run_id?: unknown }).run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

function messageSequenceId(message: LettaMessage): number | null {
  const sequenceId = (message as { seq_id?: unknown }).seq_id;
  return typeof sequenceId === "number" ? sequenceId : null;
}

const DEFAULT_MAX_WAIT_MS = 60 * 60_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ONLINE_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_RUN_STATUS_INTERVAL_MS = 10_000;
const COMPLETED_WITHOUT_TEXT_GRACE_MS = 15_000;

export function resolveEnvironmentMaxWaitMs(): number {
  const raw = process.env.LETTA_ENVIRONMENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_WAIT_MS;
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

type EnvironmentWaitMode = "unknown" | "runtime-status" | "runs";

function isRuntimeTurnOver(status: AgentRuntimeStatusEntry): boolean {
  return (
    status.state === "IDLE" || status.loop_state?.status === "WAITING_ON_INPUT"
  );
}

export async function waitForEnvironmentAssistantMessage(params: {
  backend: Backend;
  agentId: string;
  conversationId: string;
  otid: string;
  deviceId?: string;
  maxWaitMs?: number;
  inactivityTimeoutMs?: number;
  pollIntervalMs?: number;
  onlineCheckIntervalMs?: number;
  runStatusIntervalMs?: number;
  deps?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    getEnvironmentConnection?: (
      deviceId: string,
    ) => Promise<EnvironmentConnection>;
    getAgentRuntimeStatus?: (
      agentId: string,
      conversationIds: string[],
    ) => Promise<AgentRuntimeStatusSnapshot>;
  };
}): Promise<{ text: string; stopReason: StopReasonType | null }> {
  const now = params.deps?.now ?? Date.now;
  const sleep =
    params.deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchEnvironment =
    params.deps?.getEnvironmentConnection ?? getEnvironmentConnection;
  const fetchRuntimeStatus =
    params.deps?.getAgentRuntimeStatus ?? getAgentRuntimeStatus;
  const maxWaitMs = params.maxWaitMs ?? resolveEnvironmentMaxWaitMs();
  const inactivityTimeoutMs =
    params.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? 1_000;
  const onlineCheckIntervalMs =
    params.onlineCheckIntervalMs ?? DEFAULT_ONLINE_CHECK_INTERVAL_MS;
  const runStatusIntervalMs =
    params.runStatusIntervalMs ?? DEFAULT_RUN_STATUS_INTERVAL_MS;

  const startedAt = now();
  let lastProgressAt = startedAt;
  let lastOnlineCheckAt = startedAt;
  let lastRunStatusCheckAt = 0;
  let lastRuntimeStatusCheckAt = 0;
  let mode: EnvironmentWaitMode = "unknown";
  let runtimeTurnOverAt: number | null = null;
  let highestSequenceId: number | null = null;
  let completedWithoutTextAt: number | null = null;
  let inputSequenceId: number | null = null;

  while (true) {
    const page =
      params.conversationId === "default"
        ? await params.backend.listAgentMessages(params.agentId, {
            conversation_id: "default",
            limit: 50,
            order: "desc",
          })
        : await params.backend.listConversationMessages(params.conversationId, {
            limit: 50,
            order: "desc",
          });

    const messages = pageItems<LettaMessage>(page);

    for (const message of messages) {
      const sequenceId = messageSequenceId(message);
      if (
        sequenceId !== null &&
        (highestSequenceId === null || sequenceId > highestSequenceId)
      ) {
        highestSequenceId = sequenceId;
        lastProgressAt = now();
      }
    }

    if (inputSequenceId === null) {
      const inputMessage = messages.find(
        (message) =>
          isUserMessage(message) &&
          (message as { otid?: unknown }).otid === params.otid,
      );
      inputSequenceId = inputMessage ? messageSequenceId(inputMessage) : null;
    }

    let assistant: LettaMessage | undefined;
    let newestRunId: string | null = null;
    if (inputSequenceId !== null) {
      const anchorSequenceId = inputSequenceId;
      const newerMessages = messages.filter((message) => {
        const sequenceId = messageSequenceId(message);
        return sequenceId !== null && sequenceId > anchorSequenceId;
      });
      const nextUserSequenceId = newerMessages.reduce<number | null>(
        (closest, message) => {
          if (!isUserMessage(message) || isTaskNotificationMessage(message)) {
            return closest;
          }
          const sequenceId = messageSequenceId(message);
          if (sequenceId === null) return closest;
          return closest === null || sequenceId < closest
            ? sequenceId
            : closest;
        },
        null,
      );
      const turnMessages = newerMessages.filter((message) => {
        const sequenceId = messageSequenceId(message);
        return (
          sequenceId !== null &&
          (nextUserSequenceId === null || sequenceId < nextUserSequenceId)
        );
      });
      assistant = turnMessages
        .filter((message) => isAssistantMessage(message))
        .sort(
          (a, b) => (messageSequenceId(b) ?? 0) - (messageSequenceId(a) ?? 0),
        )[0];
      newestRunId =
        messageRunId(assistant) ??
        turnMessages
          .sort(
            (a, b) => (messageSequenceId(b) ?? 0) - (messageSequenceId(a) ?? 0),
          )
          .map((message) => messageRunId(message))
          .find((id) => id !== null) ??
        null;
    }

    if (mode !== "runs") {
      const shouldCheckRuntimeStatus =
        assistant !== undefined ||
        lastRuntimeStatusCheckAt === 0 ||
        now() - lastRuntimeStatusCheckAt >= runStatusIntervalMs;
      if (shouldCheckRuntimeStatus) {
        lastRuntimeStatusCheckAt = now();
        let snapshot: AgentRuntimeStatusSnapshot | null = null;
        try {
          snapshot = await fetchRuntimeStatus(params.agentId, [
            params.conversationId,
          ]);
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 404) {
            mode = "runs";
          }
        }
        if (snapshot) {
          mode = "runtime-status";
          const status =
            snapshot.statuses.find(
              (entry) => entry.conversation_id === params.conversationId,
            ) ??
            (snapshot.statuses.length === 1 ? snapshot.statuses[0] : null) ??
            null;
          if (status && !isRuntimeTurnOver(status)) {
            lastProgressAt = now();
            runtimeTurnOverAt = null;
          } else if (status && inputSequenceId !== null) {
            const text = assistant ? extractMessageText(assistant).trim() : "";
            if (text.length > 0) {
              let stopReason: StopReasonType | null = null;
              if (newestRunId) {
                try {
                  const run = await params.backend.retrieveRun(newestRunId);
                  stopReason = run.stop_reason ?? null;
                } catch {}
              }
              return { text, stopReason };
            }
            runtimeTurnOverAt ??= now();
            if (now() - runtimeTurnOverAt >= COMPLETED_WITHOUT_TEXT_GRACE_MS) {
              throw new Error(
                "Environment turn ended without an assistant reply " +
                  `(runtime state ${status.state})`,
              );
            }
          }
        }
      }
    }

    if (mode !== "runtime-status" && inputSequenceId !== null) {
      const shouldCheckRun =
        newestRunId !== null &&
        (assistant !== undefined ||
          now() - lastRunStatusCheckAt >= runStatusIntervalMs);
      if (newestRunId && shouldCheckRun) {
        lastRunStatusCheckAt = now();
        const run = await params.backend.retrieveRun(newestRunId);
        if (!isTerminalRunStatus(run.status)) {
          lastProgressAt = now();
        } else if (run.stop_reason !== "requires_approval") {
          const text = assistant ? extractMessageText(assistant).trim() : "";
          if (text.length > 0) {
            return { text, stopReason: run.stop_reason ?? null };
          }
          if (run.status === "failed" || run.status === "cancelled") {
            throw new Error(
              `Environment turn run ${newestRunId} ${run.status} without an assistant reply` +
                (run.stop_reason ? ` (stop reason: ${run.stop_reason})` : ""),
            );
          }
          completedWithoutTextAt ??= now();
          if (
            now() - completedWithoutTextAt >=
            COMPLETED_WITHOUT_TEXT_GRACE_MS
          ) {
            throw new Error(
              `Environment turn run ${newestRunId} completed without an assistant reply`,
            );
          }
        }
      }
    }

    if (params.deviceId && now() - lastOnlineCheckAt >= onlineCheckIntervalMs) {
      lastOnlineCheckAt = now();
      let offline = false;
      try {
        const connection = await fetchEnvironment(params.deviceId);
        offline = !isEnvironmentOnline(connection);
      } catch {}
      if (offline) {
        throw new Error(
          `Environment device ${params.deviceId} went offline before the turn completed`,
        );
      }
    }

    if (now() - lastProgressAt >= inactivityTimeoutMs) {
      throw new Error(
        `No activity from the environment turn for ${inactivityTimeoutMs}ms (no new messages and no running run); giving up`,
      );
    }
    if (now() - startedAt >= maxWaitMs) {
      throw new Error(
        `Environment turn did not complete within ${maxWaitMs}ms (set LETTA_ENVIRONMENT_TIMEOUT_MS to raise the ceiling)`,
      );
    }

    await sleep(pollIntervalMs);
  }
}
