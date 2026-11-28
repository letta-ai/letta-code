import { Buffer } from "node:buffer";
import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { ACTING_USER_ID_ENV, ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import { getMcpOriginatorToken } from "@/agent/mcp-originator-tokens";
import type { SkillSource } from "@/agent/skill-sources";
import { type Backend, getBackend } from "@/backend";
import { isCompactionSummaryChunk } from "@/backend/compaction-events";
import { takePendingDiskSpaceReminder } from "@/reminders/disk-space";
import { getRuntimeContext } from "@/runtime-context";
import {
  getBusyRecoveryHttpStatus,
  markBusyRequest,
  reportBusyRecovery,
  traceBusyRecoveryStream,
} from "@/telemetry/busy-recovery";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  type ClientTool,
  getExecutionContextById,
  type PreparedToolExecutionContext,
  prepareCurrentToolExecutionContext,
  waitForToolsetReady,
} from "@/tools/manager";
import type { PermissionModeState } from "@/tools/permission-mode-state";
import { scrubOutgoingMessageContent } from "@/tools/secret-substitution";
import { isCloudApiShutdownRejection } from "@/utils/cloud-api-shutdown";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";
import { ImageWorkerMissingError } from "@/utils/image-resize";
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
import { planClientSkillsRequest } from "./client-skills-baseline";
import { getSkillSources } from "./context";
import {
  extractConflictDetail,
  extractConversationBusyRunId,
  isConversationBusyError,
  parseRetryAfterHeaderMs,
} from "./turn-recovery-policy";

const streamRequestStartTimes = new WeakMap<object, number>();
const streamToolContextIds = new WeakMap<object, string>();
const RESPONSE_STATE_HEADER = "X-Letta-Response-State";
const RESPONSE_STATE_CACHE_SCOPE = "approval_boundary";
const MCP_ORIGINATOR_TOKEN_HEADER = "x-letta-mcp-originator-token";
const MCP_ORIGINATOR_ISOLATION_HEADER = "x-letta-mcp-originator-isolation";
const MCP_ORIGINATOR_SUPER_RUN_HEADER = "x-letta-mcp-originator-super-run-id";
const CLOUD_API_SHUTDOWN_MAX_RETRIES = 3;
const CLOUD_API_SHUTDOWN_DEFAULT_RETRY_DELAY_MS = 1000;
const responseStateIdsByScope = new Map<string, string>();

function getCloudApiShutdownRetryDelayMs(error: { headers?: unknown }): number {
  const headers = error.headers;
  if (!(headers instanceof Headers)) {
    return CLOUD_API_SHUTDOWN_DEFAULT_RETRY_DELAY_MS;
  }

  return (
    parseRetryAfterHeaderMs(headers.get("Retry-After")) ??
    CLOUD_API_SHUTDOWN_DEFAULT_RETRY_DELAY_MS
  );
}

async function waitForRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type StreamRequestContext = {
  conversationId: string;
  resolvedConversationId: string;
  agentId: string | null;
  actingUserId?: string;
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
    onCompaction?: () => void;
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
          if (isCompactionSummaryChunk(result.value)) {
            params.onCompaction?.();
          }
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
  agentId?: string;
  approvalNormalization?: ApprovalNormalizationOptions;
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  skillSources?: SkillSource[];
  overrideModel?: string;
  responseFormat?: Record<string, unknown>;
  preparedToolContext?: PreparedToolExecutionContext;
  allowResponseStateReuse?: boolean;
  imageFailureModesByMessageOtid?: ImageFailureModesByMessageOtid;
  actingUserId?: string | null;
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
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
    ...(isDefaultConversation ? { agent_id: opts.agentId } : {}),
  };
}

export async function sendMessageStream(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
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

export async function sendMessageStreamWithBackend(
  backend: Backend,
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  requestOptions: SendMessageStreamRequestOptions = {
    maxRetries: 0,
  },
): Promise<Stream<LettaStreamingResponse>> {
  const preparationStartedAt = performance.now();
  const requestStartTime = isTimingsEnabled()
    ? preparationStartedAt
    : undefined;
  const requestStartedAtMs = Date.now();
  const canonicalMessages = normalizeOutgoingApprovalMessages(
    messages,
    opts.approvalNormalization,
  );
  const scrubbedMessages = canonicalMessages.map((message) => {
    if (!("role" in message) || message.role !== "user") {
      return message;
    }
    return {
      ...message,
      content: scrubOutgoingMessageContent(message.content, opts.agentId),
    };
  });
  let normalizedMessages: Array<MessageCreate | ApprovalCreate>;
  try {
    normalizedMessages = await normalizeMessageImageParts(scrubbedMessages, {
      failureModesByMessageOtid: opts.imageFailureModesByMessageOtid,
    });
  } catch (error) {
    if (error instanceof ImageWorkerMissingError) {
      trackBoundaryError({
        errorType: "image_worker_missing",
        error,
        context: "send_message_image_normalization",
      });
    }
    throw error;
  }
  assertSupportedBase64ImageMediaTypes(normalizedMessages);

  const preparedToolContext = opts.preparedToolContext
    ? opts.preparedToolContext
    : await (async () => {
        await waitForToolsetReady();
        return await prepareCurrentToolExecutionContext({
          workingDirectory: opts.workingDirectory,
          permissionModeState: opts.permissionModeState,
        });
      })();
  const { clientTools, contextId } = preparedToolContext;
  const executionRuntimeContext = getExecutionContextById(
    preparedToolContext.contextId,
  )?.runtimeContext;
  const skillsStartedAt = performance.now();
  const {
    clientSkills: discoveredClientSkills,
    errors: clientSkillDiscoveryErrors,
  } = await buildClientSkillsPayload({
    agentId: opts.agentId,
    workingDirectory:
      opts.workingDirectory ??
      executionRuntimeContext?.workingDirectory ??
      undefined,
    skillsDirectory: executionRuntimeContext?.skillsDirectory,
    skillSources: opts.skillSources ?? getSkillSources(),
    bundledSkills: executionRuntimeContext?.bundledSkills,
    cloudSkillRepositories:
      executionRuntimeContext?.executionSettings?.cloud_skill_repositories,
  });

  const skillsDurationMs = Math.round(performance.now() - skillsStartedAt);
  const resolvedConversationId = conversationId;
  const responseStateScope = buildResponseStateScope(
    resolvedConversationId,
    opts.agentId ?? null,
  );
  const skillPlan = planClientSkillsRequest(
    backend,
    { conversationId: resolvedConversationId, agentId: opts.agentId },
    discoveredClientSkills,
  );
  const { clientSkills, reminder: skillReminder } = skillPlan;
  const diskReminder = takePendingDiskSpaceReminder();
  const runtimeReminders = [skillReminder, diskReminder].filter(
    (text): text is string => Boolean(text),
  );
  const requestMessages = [
    ...normalizedMessages,
    ...runtimeReminders.map((content) => ({
      type: "message" as const,
      role: "user" as const,
      content,
    })),
  ];
  const isApprovalContinuation =
    isApprovalContinuationRequest(normalizedMessages);
  const canUsePreviousResponseState =
    isApprovalContinuation &&
    opts.allowResponseStateReuse === true &&
    runtimeReminders.length === 0;
  const previousResponseId = canUsePreviousResponseState
    ? responseStateIdsByScope.get(responseStateScope)
    : undefined;
  const requestBody = buildRequestBodyFromPreparedMessages(
    conversationId,
    requestMessages,
    opts,
    clientTools,
    clientSkills,
  );

  reportAttachedRepositorySkillErrors(clientSkillDiscoveryErrors);

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

  const actingUserId =
    opts.actingUserId === null
      ? undefined
      : (opts.actingUserId ??
        executionRuntimeContext?.actingUserId ??
        getRuntimeContext()?.actingUserId ??
        process.env[ACTING_USER_ID_ENV]);
  const extraHeaders: Record<string, string> = {};
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
  if (actingUserId) {
    extraHeaders[ACTING_USER_ID_HEADER] = actingUserId;
  }
  const originatorSuperRunId = executionRuntimeContext
    ? executionRuntimeContext.mcpOriginatorSuperRunId
    : getRuntimeContext()?.mcpOriginatorSuperRunId;
  const originatorToken = getMcpOriginatorToken(originatorSuperRunId);
  if (originatorToken && originatorSuperRunId) {
    extraHeaders[MCP_ORIGINATOR_TOKEN_HEADER] = originatorToken;
    extraHeaders[MCP_ORIGINATOR_ISOLATION_HEADER] = "1";
    extraHeaders[MCP_ORIGINATOR_SUPER_RUN_HEADER] = originatorSuperRunId;
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
  const dispatchStartedAt = performance.now();
  debugLog(
    "send-message-stream",
    "request_start conversation_id=%s agent_id=%s messages=%s otid=%s stream_tokens=%s background=%s max_retries=%s preparation_ms=%d client_skills_ms=%d",
    resolvedConversationId,
    opts.agentId ?? "none",
    messageSummary || "(empty)",
    firstOtid ?? "none",
    opts.streamTokens ?? true,
    opts.background ?? true,
    requestOptions.maxRetries ?? "default",
    Math.round(dispatchStartedAt - preparationStartedAt),
    skillsDurationMs,
  );

  let stream: Stream<LettaStreamingResponse>;
  const abortRelay = createStreamAbortRelay(requestOptions.signal);
  let cloudApiShutdownRetries = 0;
  while (true) {
    const attemptStartedAt = performance.now();
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
      const onSkillsCompaction = skillPlan.accept();
      stream = attachResponseStateTracking(stream, {
        scope: responseStateScope,
        conversationId: resolvedConversationId,
        agentId: opts.agentId ?? null,
        onCompaction: onSkillsCompaction,
      });
      break;
    } catch (error) {
      if (
        isCloudApiShutdownRejection(error) &&
        cloudApiShutdownRetries < CLOUD_API_SHUTDOWN_MAX_RETRIES
      ) {
        cloudApiShutdownRetries += 1;
        const delayMs = getCloudApiShutdownRetryDelayMs(error);
        debugWarn(
          "send-message-stream",
          "request_retry conversation_id=%s otid=%s reason=cloud_api_shutting_down attempt=%d delay_ms=%d attempt_ms=%d",
          resolvedConversationId,
          firstOtid ?? "none",
          cloudApiShutdownRetries,
          delayMs,
          Math.round(performance.now() - attemptStartedAt),
        );
        try {
          await waitForRetryDelay(
            delayMs,
            abortRelay?.signal ?? requestOptions.signal,
          );
        } catch (abortError) {
          abortRelay?.cleanup();
          throw abortError instanceof APIUserAbortError
            ? abortError
            : new APIUserAbortError();
        }
        continue;
      }

      abortRelay?.cleanup();
      const detail = extractConflictDetail(error);
      if (isConversationBusyError(detail)) {
        markBusyRequest(backend, resolvedConversationId, firstOtid);
        reportBusyRecovery("send_rejected", {
          conversationId: resolvedConversationId,
          otid: firstOtid,
          blockerRunId: extractConversationBusyRunId(detail) ?? undefined,
          httpStatus: getBusyRecoveryHttpStatus(error),
        });
      }
      debugWarn(
        "send-message-stream",
        "request_error conversation_id=%s otid=%s status=%s request_ms=%d error=%s",
        resolvedConversationId,
        firstOtid ?? "none",
        (error as { status?: number })?.status ?? "none",
        Math.round(performance.now() - dispatchStartedAt),
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  debugLog(
    "send-message-stream",
    "request_ok conversation_id=%s otid=%s request_ms=%d",
    resolvedConversationId,
    firstOtid ?? "none",
    Math.round(performance.now() - dispatchStartedAt),
  );

  stream = traceBusyRecoveryStream(
    stream,
    resolvedConversationId,
    firstOtid,
    requestOptions.signal,
    backend,
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
    ...(actingUserId ? { actingUserId } : {}),
    requestStartedAtMs,
    otid: firstOtid,
  });

  return stream;
}

function reportAttachedRepositorySkillErrors(
  errors: ReadonlyArray<{ path: string; message: string }>,
): void {
  for (const error of errors) {
    if (!error.path.startsWith("shared-memory:")) continue;
    trackBoundaryError({
      errorType: "client_skills_attached_repositories_error",
      error: error.message,
      context: "send_message_client_skills",
    });
  }
}
