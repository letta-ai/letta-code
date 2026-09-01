import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message as LettaMessage } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { Backend } from "@/backend";
import type { SendEnvironmentMessageBody } from "@/backend/api/environments";
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

export async function waitForEnvironmentAssistantMessage(params: {
  backend: Backend;
  agentId: string;
  conversationId: string;
  otid: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ text: string; stopReason: StopReasonType | null }> {
  const timeoutMs = params.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = params.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let inputSequenceId: number | null = null;

  while (Date.now() < deadline) {
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
      const assistant = newerMessages
        .filter((message) => {
          const sequenceId = messageSequenceId(message);
          return (
            isAssistantMessage(message) &&
            sequenceId !== null &&
            (nextUserSequenceId === null || sequenceId < nextUserSequenceId)
          );
        })
        .sort(
          (a, b) => (messageSequenceId(b) ?? 0) - (messageSequenceId(a) ?? 0),
        )[0];
      const runId = messageRunId(assistant);
      if (runId) {
        const run = await params.backend.retrieveRun(runId);
        if (
          (run.status === "completed" ||
            run.status === "failed" ||
            run.status === "cancelled") &&
          run.stop_reason !== "requires_approval"
        ) {
          const text = assistant ? extractMessageText(assistant).trim() : "";
          if (text.length > 0) {
            return { text, stopReason: run.stop_reason ?? null };
          }
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out waiting for environment turn completion");
}
