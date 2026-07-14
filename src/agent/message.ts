/**
 * Utilities for sending messages to an agent via conversations
 **/

import { Buffer } from "node:buffer";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { type Backend, getBackend } from "@/backend";
import {
  type ClientTool,
  type PermissionModeState,
  type PreparedToolExecutionContext,
  prepareCurrentToolExecutionContext,
  waitForToolsetReady,
} from "@/tools/manager";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";
import {
  assertSupportedBase64ImageMediaTypes,
  type ImageFailureModesByMessageOtid,
  normalizeMessageImageParts,
} from "@/utils/message-image-normalization";
import { createStreamAbortRelay } from "@/utils/stream-abort-relay";
import { isTimingsEnabled } from "@/utils/timing";
import {
  type ApprovalNormalizationOptions,
  normalizeOutgoingApprovalMessages,
} from "./approval-result-normalization";
import { buildClientSkillsPayload } from "./client-skills";
import { getSkillSources } from "./context";

const streamRequestStartTimes = new WeakMap<object, number>();
const streamToolContextIds = new WeakMap<object, string>();
const RESPONSE_STATE_HEADER = "X-Letta-Response-State";
const RESPONSE_STATE_CACHE_SCOPE = "approval_boundary";
const responseStateIdsByScope = new Map<string, string>();

export type StreamRequestContext = {
  conversationId: string;
  resolvedConversationId: string;
  agentId: string | null;
  requestStartedAtMs: number;
  otid?: string;
};
const streamRequestContexts = new WeakMap<object, StreamRequestContext>();

type ResponseStateChunk = {
  message_type?: unknown;
  response_id?: unknown;
  cache_scope?: unknown;
};

type ResponseStateHeaderPayload = {
  v: 1;
  cache_scope: typeof RESPONSE_STATE_CACHE_SCOPE;
  previous_response_id?: string;
};

function buildResponseStateScope(
  conversationId: string,
  agentId: string | null | undefined,
): string {
  return agentId ? `${conversationId}:${agentId}` : conversationId;
}

function getResponseStateId(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) {
    return null;
  }

  const candidate = chunk as ResponseStateChunk;
  if (
    candidate.message_type !== "response_state" ||
    candidate.cache_scope !== RESPONSE_STATE_CACHE_SCOPE
  ) {
    return null;
  }

  return typeof candidate.response_id === "string" &&
    candidate.response_id.length > 0
    ? candidate.response_id
    : null;
}

function encodeResponseStateHeader(
  payload: ResponseStateHeaderPayload,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isApprovalContinuationRequest(
  messages: Array<MessageCreate | ApprovalCreate>,
): boolean {
  if (messages.length !== 1) {
    return false;
  }

  const [message] = messages;
  return (
    Boolean(message) &&
    (message as { type?: unknown }).type === "approval" &&
    Array.isArray((message as { approvals?: unknown }).approvals)
  );
}

function attachResponseStateTracking(
  stream: Stream<LettaStreamingResponse>,
  params: {
    scope: string;
    conversationId: string;
    agentId: string | null;
  },
): Stream<LettaStreamingResponse> {
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  const streamWithIterator = stream as Stream<LettaStreamingResponse> & {
    [Symbol.asyncIterator]: () => AsyncIterator<LettaStreamingResponse>;
  };

  streamWithIterator[Symbol.asyncIterator] = () => {
    const iterator = originalAsyncIterator();

    return {
      async next() {
        const result = await iterator.next();
        if (!result.done) {
          const responseId = getResponseStateId(result.value);
          if (responseId) {
            responseStateIdsByScope.set(params.scope, responseId);
            debugLog(
              "response-state",
              "received response_id=%s conversation_id=%s agent_id=%s",
              responseId,
              params.conversationId,
              params.agentId ?? "none",
            );
          }
        }

        return result;
      },
      return(value?: unknown) {
        if (iterator.return) {
          return iterator.return(value);
        }
        return Promise.resolve({
          done: true as const,
          value: value as LettaStreamingResponse,
        });
      },
      throw(error?: unknown) {
        if (iterator.throw) {
          return iterator.throw(error);
        }
        return Promise.reject(error);
      },
    };
  };

  return stream;
}

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
  /**
   * Allow sending a cached previous response id for this request. Callers should
   * set this only for approval continuations that were fully auto-handled by
   * the client, with no human approval/denial in the loop.
   */
  allowResponseStateReuse?: boolean;
  /**
   * Per-message failure policy for best-effort channel attachments. Images are
   * always normalized; entries here only choose whether a failed conversion is
   * dropped instead of failing the request.
   */
  imageFailureModesByMessageOtid?: ImageFailureModesByMessageOtid;
  /**
   * Cloud user id of the human who pressed "send" (multi-user
   * sandbox scenario). When set, `sendMessageStream` echoes this on
   * the outbound HTTP request as the `X-Letta-Acting-User-Id`
   * header so cloud-api can re-attribute credits + rate limits to
   * the actual sender — rather than the user whose API key is the
   * bearer credential (i.e. whoever spawned the sandbox).
   *
   * Set by the listener after reading
   * `runtime.acting_user_id` from cloud's status WS frame; absent
   * for self-hosted / single-user / pre-channel-split flows.
   */
  actingUserId?: string;
};

export type SendMessageStreamRequestOptions = {
  maxRetries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
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
  return buildRequestBodyFromPreparedMessages(
    conversationId,
    normalizeOutgoingApprovalMessages(messages, opts.approvalNormalization),
    opts,
    clientTools,
    clientSkills,
  );
}

function buildRequestBodyFromPreparedMessages(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions,
  clientTools: ClientTool[],
  clientSkills: NonNullable<ConversationMessageCreateParams["client_skills"]>,
) {
  const isDefaultConversation = conversationId === "default";
  if (isDefaultConversation && !opts.agentId) {
    throw new Error(
      "agentId is required in opts when using default conversation",
    );
  }

  return {
    messages,
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
  requestOptions: SendMessageStreamRequestOptions = {
    maxRetries: 0,
  },
): Promise<Stream<LettaStreamingResponse>> {
  return sendMessageStreamWithBackend(
    getBackend(),
    conversationId,
    messages,
    opts,
    requestOptions,
  );
}

/**
 * Send a message through an explicit backend instance. Use this when a caller
 * composes several backend operations and needs fork/send to stay on the same
 * backend without reaching back through the global backend singleton.
 */
export async function sendMessageStreamWithBackend(
  backend: Backend,
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  requestOptions: SendMessageStreamRequestOptions = {
    maxRetries: 0,
  },
): Promise<Stream<LettaStreamingResponse>> {
  const requestStartTime = isTimingsEnabled() ? performance.now() : undefined;
  const requestStartedAtMs = Date.now();
  const canonicalMessages = normalizeOutgoingApprovalMessages(
    messages,
    opts.approvalNormalization,
  );
  const normalizedMessages = await normalizeMessageImageParts(
    canonicalMessages,
    {
      failureModesByMessageOtid: opts.imageFailureModesByMessageOtid,
    },
  );
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
  const responseStateScope = buildResponseStateScope(
    resolvedConversationId,
    opts.agentId ?? null,
  );
  const isApprovalContinuation =
    isApprovalContinuationRequest(normalizedMessages);
  // Only reuse cached response state when the approval continuation was fully
  // auto-handled by the client. If a human reviewed any approval, the pause can
  // allow visible agent/conversation state to change, so use the full server path.
  const canUsePreviousResponseState =
    isApprovalContinuation && opts.allowResponseStateReuse === true;
  const previousResponseId = canUsePreviousResponseState
    ? responseStateIdsByScope.get(responseStateScope)
    : undefined;
  const requestBody = buildRequestBodyFromPreparedMessages(
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
  if (previousResponseId) {
    extraHeaders[RESPONSE_STATE_HEADER] = encodeResponseStateHeader({
      v: 1,
      cache_scope: RESPONSE_STATE_CACHE_SCOPE,
      previous_response_id: previousResponseId,
    });
    responseStateIdsByScope.delete(responseStateScope);
    debugLog(
      "response-state",
      "sending previous_response_id=%s cache_scope=%s conversation_id=%s agent_id=%s",
      previousResponseId,
      RESPONSE_STATE_CACHE_SCOPE,
      resolvedConversationId,
      opts.agentId ?? "none",
    );
  } else if (!canUsePreviousResponseState) {
    responseStateIdsByScope.delete(responseStateScope);
  }
  // Echo the cloud user id back to cloud-api so it can re-attribute
  // credits + rate limits on multi-user sandboxes. See
  // SendMessageStreamOptions.actingUserId for full context.
  if (opts.actingUserId) {
    extraHeaders["X-Letta-Acting-User-Id"] = opts.actingUserId;
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
    stream = await backend.createConversationMessageStream(
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
    stream = attachResponseStateTracking(stream, {
      scope: responseStateScope,
      conversationId: resolvedConversationId,
      agentId: opts.agentId ?? null,
    });
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
