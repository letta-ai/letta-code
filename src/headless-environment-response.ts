import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message as LettaMessage } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { Backend } from "@/backend";
import {
  type EnvironmentConnection,
  getEnvironmentConnection,
  isEnvironmentOnline,
  type SendEnvironmentMessageBody,
} from "@/backend/api/environments";
import { toolFilter } from "@/tools/filter";

/**
 * Build the POST body for an environment-routed turn.
 *
 * Includes the local client-tool restriction (the `--tools` flag, stored in
 * toolFilter) as `client_tool_allowlist` so the remote listener enforces the
 * same toolset the local turn would have used. `null` (no filter) omits the
 * field and preserves the listener's normal toolset; an empty list travels as
 * an empty array, which the listener treats as "no client tools". Older cloud
 * servers strip the field, which degrades to the previous behavior (the
 * listener's own toolset) rather than failing.
 */
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

/** Absolute ceiling on an environment-routed turn. */
const DEFAULT_MAX_WAIT_MS = 60 * 60_000;
/** Give up when nothing observable happens for this long. */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ONLINE_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_RUN_STATUS_INTERVAL_MS = 10_000;
/** A completed run should have written its assistant message; allow a short lag. */
const COMPLETED_WITHOUT_TEXT_GRACE_MS = 15_000;

/**
 * Ceiling for waiting on an environment-routed turn. Overridable with
 * LETTA_ENVIRONMENT_TIMEOUT_MS (milliseconds); defaults to one hour.
 */
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

/**
 * Wait for the assistant reply of an environment-routed turn.
 *
 * The remote turn runs on another machine; this poller only observes the
 * conversation through the API. Instead of a single wall-clock timeout, it
 * keeps waiting while there is evidence the turn is alive (new messages, a
 * run that is still running, the device still online) and fails when:
 *
 * - the device goes offline (checked every `onlineCheckIntervalMs` when
 *   `deviceId` is provided);
 * - the run reaches a terminal state without an assistant reply;
 * - nothing observable happens for `inactivityTimeoutMs`; or
 * - the absolute ceiling `maxWaitMs` is hit (default one hour, overridable
 *   with LETTA_ENVIRONMENT_TIMEOUT_MS).
 */
export async function waitForEnvironmentAssistantMessage(params: {
  backend: Backend;
  agentId: string;
  conversationId: string;
  otid: string;
  /** Device to liveness-check while waiting. Omitting skips online checks. */
  deviceId?: string;
  maxWaitMs?: number;
  inactivityTimeoutMs?: number;
  pollIntervalMs?: number;
  onlineCheckIntervalMs?: number;
  runStatusIntervalMs?: number;
  /** Injectable for deterministic tests. */
  deps?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    getEnvironmentConnection?: (
      deviceId: string,
    ) => Promise<EnvironmentConnection>;
  };
}): Promise<{ text: string; stopReason: StopReasonType | null }> {
  const now = params.deps?.now ?? Date.now;
  const sleep =
    params.deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchEnvironment =
    params.deps?.getEnvironmentConnection ?? getEnvironmentConnection;
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

    // Any new message in the conversation counts as progress.
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

    if (inputSequenceId !== null) {
      const anchorSequenceId = inputSequenceId;
      // Approval continuations get new run IDs, so use the input's OTID as the
      // turn anchor and follow messages only until the next user turn begins.
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
      const assistant = turnMessages
        .filter((message) => isAssistantMessage(message))
        .sort(
          (a, b) => (messageSequenceId(b) ?? 0) - (messageSequenceId(a) ?? 0),
        )[0];
      // Tool calls and reasoning also carry the turn's run_id, so a run can be
      // observed (and liveness-checked) before any assistant message exists.
      const newestRunId =
        messageRunId(assistant) ??
        turnMessages
          .sort(
            (a, b) => (messageSequenceId(b) ?? 0) - (messageSequenceId(a) ?? 0),
          )
          .map((message) => messageRunId(message))
          .find((id) => id !== null) ??
        null;
      const shouldCheckRun =
        newestRunId !== null &&
        (assistant !== undefined ||
          now() - lastRunStatusCheckAt >= runStatusIntervalMs);
      if (newestRunId && shouldCheckRun) {
        lastRunStatusCheckAt = now();
        const run = await params.backend.retrieveRun(newestRunId);
        if (!isTerminalRunStatus(run.status)) {
          // The run is still executing; that is progress even when the
          // conversation has been quiet (e.g. one long tool call).
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
          // Completed without text: allow a short lag for the assistant
          // message to land, then give up.
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
      } catch {
        // Transient lookup failure; the other liveness checks still apply.
      }
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
