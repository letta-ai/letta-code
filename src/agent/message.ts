/**
 * Utilities for sending messages to an agent via conversations
 **/

import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { getClient } from "../backend/api/client";
import {
  type ClientTool,
  type PermissionModeState,
  type PreparedToolExecutionContext,
  prepareCurrentToolExecutionContext,
  waitForToolsetReady,
} from "../tools/manager";
import { debugLog, debugWarn, isDebugEnabled } from "../utils/debug";
import {
  assertSupportedBase64ImageMediaTypes,
  normalizeMessageImageParts,
} from "../utils/messageImageNormalization";
import { createStreamAbortRelay } from "../utils/streamAbortRelay";
import { isTimingsEnabled } from "../utils/timing";
import {
  type ApprovalNormalizationOptions,
  normalizeOutgoingApprovalMessages,
} from "./approval-result-normalization";
import { buildClientSkillsPayload } from "./clientSkills";
import { getSkillSources } from "./context";

const streamRequestStartTimes = new WeakMap<object, number>();
const streamToolContextIds = new WeakMap<object, string>();

export type StreamRequestContext = {
  conversationId: string;
  resolvedConversationId: string;
  agentId: string | null;
  requestStartedAtMs: number;
  otid?: string;
};
const streamRequestContexts = new WeakMap<object, StreamRequestContext>();

export function getStreamRequestStartTime(
  stream: Stream<LettaStreamingResponse>,
): number | undefined {
  return streamRequestStartTimes.get(stream as object);
}

export function getStreamToolContextId(
  stream: Stream<LettaStreamingResponse>,
): string | null {
  return streamToolContextIds.get(stream as object) ?? null;
}

export function getStreamRequestContext(
  stream: Stream<LettaStreamingResponse>,
): StreamRequestContext | undefined {
  return streamRequestContexts.get(stream as object);
}

export type SendMessageStreamOptions = {
  streamTokens?: boolean;
  background?: boolean;
  agentId?: string; // Required when conversationId is "default"
  approvalNormalization?: ApprovalNormalizationOptions;
  workingDirectory?: string;
  /** Per-conversation permission mode state. When provided, tool execution uses
   *  this scoped state instead of the global permissionMode singleton. */
  permissionModeState?: PermissionModeState;
  /**
   * Per-request model override. Uses backend request-scoped override_model and
   * does not mutate agent/conversation persisted model configuration.
   */
  overrideModel?: string;
  /** Explicit turn-scoped tool snapshot. When present, bypasses the global registry. */
  preparedToolContext?: PreparedToolExecutionContext;
};

export function buildConversationMessagesCreateRequestBody(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  clientTools: ClientTool[],
  clientSkills: NonNullable<
    ConversationMessageCreateParams["client_skills"]
  > = [],
) {
  const isDefaultConversation = conversationId === "default";
  if (isDefaultConversation && !opts.agentId) {
    throw new Error(
      "agentId is required in opts when using default conversation",
    );
  }

  return {
    messages: normalizeOutgoingApprovalMessages(
      messages,
      opts.approvalNormalization,
    ),
    streaming: true,
    stream_tokens: opts.streamTokens ?? true,
    include_pings: true,
    background: opts.background ?? true,
    client_skills: clientSkills,
    client_tools: clientTools,
    include_compaction_messages: true,
    ...(opts.overrideModel ? { override_model: opts.overrideModel } : {}),
    ...(isDefaultConversation ? { agent_id: opts.agentId } : {}),
  };
}

/**
 * Send a message to a conversation and return a streaming response.
 * Uses the conversations API for all conversations.
 *
 * For the "default" conversation (agent's primary message history without
 * an explicit conversation object), pass conversationId="default" and
 * provide agentId in opts. The agent id is sent in the request body.
 */
export async function sendMessageStream(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  // Disable SDK retries by default - state management happens outside the stream,
  // so retries would violate idempotency and create race conditions
  requestOptions: {
    maxRetries?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {
    maxRetries: 0,
  },
): Promise<Stream<LettaStreamingResponse>> {
  const requestStartTime = isTimingsEnabled() ? performance.now() : undefined;
  const requestStartedAtMs = Date.now();
  const client = await getClient();
  const normalizedMessages = await normalizeMessageImageParts(messages);
  assertSupportedBase64ImageMediaTypes(normalizedMessages);

  const preparedToolContext = opts.preparedToolContext
    ? opts.preparedToolContext
    : await (async () => {
        // Wait for any in-progress toolset switch to complete before reading tools
        // This prevents sending messages with stale tools during a switch
        await waitForToolsetReady();
        return await prepareCurrentToolExecutionContext({
          workingDirectory: opts.workingDirectory,
          permissionModeState: opts.permissionModeState,
        });
      })();
  const { clientTools, contextId } = preparedToolContext;
  const { clientSkills, errors: clientSkillDiscoveryErrors } =
    await buildClientSkillsPayload({
      agentId: opts.agentId,
      skillSources: getSkillSources(),
    });

  const resolvedConversationId = conversationId;
  const requestBody = buildConversationMessagesCreateRequestBody(
    conversationId,
    normalizedMessages,
    opts,
    clientTools,
    clientSkills,
  );

  if (isDebugEnabled()) {
    debugLog(
      "agent-message",
      "sendMessageStream: conversationId=%s, agentId=%s",
      conversationId,
      opts.agentId ?? "(none)",
    );

    const formattedSkills = clientSkills.map(
      (skill) => `${skill.name} (${skill.location})`,
    );
    debugLog(
      "agent-message",
      "sendMessageStream: client_skills (%d) %s",
      clientSkills.length,
      formattedSkills.length > 0 ? formattedSkills.join(", ") : "(none)",
    );

    if (clientSkillDiscoveryErrors.length > 0) {
      for (const error of clientSkillDiscoveryErrors) {
        debugWarn(
          "agent-message",
          "sendMessageStream: client_skills discovery error at %s: %s",
          error.path,
          error.message,
        );
      }
    }
  }

  const extraHeaders: Record<string, string> = {};
  if (process.env.LETTA_RESPONSES_WS === "1") {
    extraHeaders["X-Experimental-OpenAI-Responses-Websocket"] = "true";
  }

  const messageSummary = normalizedMessages
    .map((item) => {
      if (item.type === "approval") {
        return `approval:${item.approvals?.length ?? 0}`;
      }
      if (item.type !== "message") {
        return `unknown:${item.type}`;
      }
      const content = item.content;
      if (typeof content === "string") {
        return `message:str:${content.length}`;
      }
      return `message:parts:${content.length}`;
    })
    .join(",");

  const firstOtid = (normalizedMessages[0] as unknown as { otid?: string })
    ?.otid;
  debugLog(
    "send-message-stream",
    "request_start conversation_id=%s agent_id=%s messages=%s otid=%s stream_tokens=%s background=%s max_retries=%s",
    resolvedConversationId,
    opts.agentId ?? "none",
    messageSummary || "(empty)",
    firstOtid ?? "none",
    opts.streamTokens ?? true,
    opts.background ?? true,
    requestOptions.maxRetries ?? "default",
  );

  let stream: Stream<LettaStreamingResponse>;
  const abortRelay = createStreamAbortRelay(requestOptions.signal);
  try {
    stream = await client.conversations.messages.create(
      resolvedConversationId,
      requestBody,
      {
        ...requestOptions,
        ...(abortRelay ? { signal: abortRelay.signal } : {}),
        headers: {
          ...((requestOptions.headers as Record<string, string>) ?? {}),
          ...extraHeaders,
        },
      },
    );
  } catch (error) {
    abortRelay?.cleanup();
    debugWarn(
      "send-message-stream",
      "request_error conversation_id=%s otid=%s status=%s error=%s",
      resolvedConversationId,
      firstOtid ?? "none",
      (error as { status?: number })?.status ?? "none",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  debugLog(
    "send-message-stream",
    "request_ok conversation_id=%s otid=%s",
    resolvedConversationId,
    firstOtid ?? "none",
  );

  abortRelay?.attach(stream as object);

  if (requestStartTime !== undefined) {
    streamRequestStartTimes.set(stream as object, requestStartTime);
  }
  streamToolContextIds.set(stream as object, contextId);
  streamRequestContexts.set(stream as object, {
    conversationId,
    resolvedConversationId,
    agentId: opts.agentId ?? null,
    requestStartedAtMs,
    otid: firstOtid,
  });

  return stream;
}
