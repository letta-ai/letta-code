import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import { fetchRunErrorInfo } from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { sendMessageStream } from "@/agent/message";
import {
  buildFreshDenialApprovals,
  extractConflictDetail,
  extractConversationBusyRunId,
  getPreStreamErrorAction,
  getRetryDelayMs,
  parseRetryAfterHeaderMs,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/turn-recovery-policy";
import { type ConversationMessageStreamBody, getBackend } from "@/backend";
import { getRetryStatusMessage } from "@/cli/helpers/error-formatter";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import { createStreamAbortRelay } from "@/utils/stream-abort-relay";
import {
  rememberPendingApprovalBatchIds,
  resolveRecoveryBatchId,
} from "./approval";
import {
  LLM_API_ERROR_MAX_RETRIES,
  MAX_PRE_STREAM_RECOVERY,
  PROVIDER_FALLBACK_NOTICE,
} from "./constants";
import { appendQueuedTurnToInput } from "./continuation-input";
import { getConversationWorkingDirectory } from "./cwd";
import {
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "./mod-adapter";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { emitDequeuedUserMessage, emitRetryDelta } from "./protocol-outbound";
import {
  maybeApplyProviderFallback,
  type ProviderFallbackState,
} from "./provider-fallback";
import { consumeQueuedTurn } from "./queue";
import { emitRecoverableRetryNotice } from "./recoverable-notices";
import {
  drainRecoveryStreamWithEmission,
  isApprovalToolCallDesyncError,
} from "./recovery";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ListenerTransport } from "./transport";
import { createTurnInputState } from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";
import type { ConversationRuntime } from "./types";

const ACTIVE_BLOCKING_RUN_STATUSES = new Set(["created", "running"]);
const BUSY_RUN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const BUSY_RUN_POLL_INTERVAL_MS = 5000;

type MessageStreamResult = Awaited<ReturnType<typeof sendMessageStream>>;
type RecoveryDrainResult = Awaited<
  ReturnType<typeof drainRecoveryStreamWithEmission>
>;
type RetrieveAgent = ReturnType<typeof getBackend>["retrieveAgent"];
export type ApprovalContinuationSendResult =
  | { kind: "stream"; stream: NonNullable<MessageStreamResult> }
  | { kind: "terminal"; drainResult: RecoveryDrainResult };
type BlockingRunWaitResult = "settled" | "timed_out" | "unavailable";

export function isApprovalOnlyInput(
  input: Array<MessageCreate | ApprovalCreate>,
): boolean {
  return (
    input.length === 1 &&
    input[0] !== undefined &&
    "type" in input[0] &&
    input[0].type === "approval"
  );
}

export function markAwaitingAcceptedApprovalContinuationRunId(
  runtime: ConversationRuntime,
  turnLease: TurnLease,
  input: Array<MessageCreate | ApprovalCreate>,
): void {
  if (isApprovalOnlyInput(input)) {
    runtime.turnLifecycle.setRunId(turnLease, null);
  }
}

function isBackendNotFoundError(err: unknown): boolean {
  return (
    (err instanceof APIError && (err.status === 404 || err.status === 422)) ||
    (err instanceof Error && err.name === "LocalBackendNotFoundError")
  );
}

function isBlockingRunActive(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_BLOCKING_RUN_STATUSES.has(status);
}

async function sleepWithAbort(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      abortSignal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      cleanup();
      reject(new Error("Cancelled by user"));
    }

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

async function waitForBlockingRunToSettle(
  runId: string,
  abortSignal?: AbortSignal,
): Promise<BlockingRunWaitResult> {
  const timeoutMs = BUSY_RUN_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }

    let run: Awaited<ReturnType<ReturnType<typeof getBackend>["retrieveRun"]>>;
    try {
      run = await getBackend().retrieveRun(runId);
    } catch {
      return "unavailable";
    }

    if (!isBlockingRunActive(run.status)) {
      return "settled";
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return "timed_out";
    }

    await sleepWithAbort(
      Math.min(BUSY_RUN_POLL_INTERVAL_MS, timeoutMs - elapsedMs),
      abortSignal,
    );
  }
}

async function maybeWaitForBlockingRun(params: {
  runId: string | null;
  retriedAfterSettled: Set<string>;
  abortSignal?: AbortSignal;
}): Promise<"retry_now" | "fall_back"> {
  const { runId, retriedAfterSettled, abortSignal } = params;
  if (!runId) {
    return "fall_back";
  }

  const waitResult = await waitForBlockingRunToSettle(runId, abortSignal);

  if (waitResult === "settled") {
    if (retriedAfterSettled.has(runId)) {
      return "fall_back";
    }
    retriedAfterSettled.add(runId);
    return "retry_now";
  }

  if (waitResult === "timed_out") {
    throw new Error(
      `Conversation is still busy because run ${runId} remained active after ${BUSY_RUN_WAIT_TIMEOUT_MS}ms`,
    );
  }

  return "fall_back";
}

function getConversationBusyRetryNotice(
  blockingRunId: string | null,
  retryDelayMs: number,
): { message: string; delayMs: number } {
  if (!blockingRunId) {
    return {
      message: "Conversation is busy, waiting and retrying…",
      delayMs: retryDelayMs,
    };
  }

  return {
    message: `Conversation is busy; waiting for run ${blockingRunId} to finish…`,
    delayMs: BUSY_RUN_POLL_INTERVAL_MS,
  };
}

async function tryResumeBusyConversationStream(params: {
  conversationId: string;
  messages: Parameters<typeof sendMessageStream>[1];
  runtime: ConversationRuntime;
  abortSignal?: AbortSignal;
  debugMessage: string;
}): Promise<MessageStreamResult | null> {
  const { conversationId, messages, runtime, abortSignal, debugMessage } =
    params;

  try {
    const backend = getBackend();
    const messageOtid = messages
      .map((item) => (item as Record<string, unknown>).otid)
      .find((value): value is string => typeof value === "string");
    const resumeAbortRelay = createStreamAbortRelay(abortSignal);

    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }

    try {
      const resumeStream = await backend.streamConversationMessages(
        conversationId,
        {
          agent_id:
            conversationId === "default"
              ? (runtime.agentId ?? undefined)
              : undefined,
          otid: messageOtid ?? undefined,
          starting_after: 0,
          batch_size: 1000,
        } as unknown as ConversationMessageStreamBody,
        resumeAbortRelay ? { signal: resumeAbortRelay.signal } : undefined,
      );
      resumeAbortRelay?.attach(resumeStream as object);
      return resumeStream;
    } catch (resumeError) {
      resumeAbortRelay?.cleanup();
      throw resumeError;
    }
  } catch (resumeError) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    if (process.env.DEBUG) {
      console.warn(
        debugMessage,
        resumeError instanceof Error
          ? resumeError.message
          : String(resumeError),
      );
    }
    return null;
  }
}

/**
 * Attempt to resolve stale pending approvals by fetching them from the backend
 * and auto-denying. This is the Phase 3 bounded recovery mechanism — it does NOT
 * touch pendingInterruptedResults (that's exclusively owned by handleIncomingMessage).
 */
export async function resolveStaleApprovals(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  turnLease: TurnLease,
  deps: {
    getResumeData?: typeof getResumeDataFromBackend;
    retrieveAgent?: RetrieveAgent;
    prepareToolExecutionContext?: typeof prepareToolExecutionContextForScope;
  } = {},
): Promise<Awaited<ReturnType<typeof drainRecoveryStreamWithEmission>> | null> {
  if (!runtime.agentId) return null;

  const getResumeDataImpl = deps.getResumeData ?? getResumeDataFromBackend;
  const prepareToolExecutionContext =
    deps.prepareToolExecutionContext ?? prepareToolExecutionContextForScope;
  const assertCurrentTurnLease = () => {
    if (
      turnLease.signal.aborted ||
      !runtime.turnLifecycle.isCurrent(turnLease)
    ) {
      throw new Error("Cancelled by user");
    }
  };

  assertCurrentTurnLease();
  const backend = getBackend();
  let agent: Awaited<ReturnType<typeof backend.retrieveAgent>>;
  try {
    agent = await (deps.retrieveAgent
      ? deps.retrieveAgent(runtime.agentId)
      : backend.retrieveAgent(runtime.agentId));
  } catch (err) {
    assertCurrentTurnLease();
    if (isBackendNotFoundError(err)) {
      return null;
    }
    throw err;
  }
  assertCurrentTurnLease();
  const requestedConversationId =
    runtime.conversationId !== "default" ? runtime.conversationId : undefined;

  let resumeData: Awaited<ReturnType<typeof getResumeDataFromBackend>>;
  try {
    resumeData = await getResumeDataImpl(agent, requestedConversationId, {
      includeMessageHistory: false,
    });
  } catch (err) {
    assertCurrentTurnLease();
    if (isBackendNotFoundError(err)) {
      return null;
    }
    throw err;
  }
  assertCurrentTurnLease();

  let pendingApprovals = resumeData.pendingApprovals || [];
  if (pendingApprovals.length === 0) return null;

  const recoveryConversationId = runtime.conversationId;
  const recoveryWorkingDirectory =
    runtime.activeWorkingDirectory ??
    getConversationWorkingDirectory(
      runtime.listener,
      runtime.agentId,
      recoveryConversationId,
    );
  const scope = {
    agent_id: runtime.agentId,
    conversation_id: recoveryConversationId,
  } as const;
  const modAdapters = await ensureListenerModAdaptersForAgent(
    runtime.listener,
    runtime.agentId,
  );
  const preparedToolContext = await prepareToolExecutionContext({
    agentId: runtime.agentId,
    conversationId: recoveryConversationId,
    workingDirectory: recoveryWorkingDirectory,
    permissionModeState: getOrCreateConversationPermissionModeStateRef(
      runtime.listener,
      runtime.agentId,
      runtime.conversationId,
    ),
    modAdapters,
    modEvents: createListenerModEvents(modAdapters),
  });
  assertCurrentTurnLease();
  runtime.currentToolset = preparedToolContext.toolset;
  runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
  runtime.currentLoadedTools =
    preparedToolContext.preparedToolContext.loadedToolNames;

  while (pendingApprovals.length > 0) {
    assertCurrentTurnLease();
    const recoveryBatchId = resolveRecoveryBatchId(runtime, pendingApprovals);
    if (!recoveryBatchId) {
      throw new Error(
        "Ambiguous pending approval batch mapping during recovery",
      );
    }
    rememberPendingApprovalBatchIds(runtime, pendingApprovals, recoveryBatchId);

    const approvalResults = buildFreshDenialApprovals(
      pendingApprovals,
      STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    );
    if (approvalResults.length === 0) {
      return null;
    }

    try {
      let continuationInput = createTurnInputState([
        {
          type: "approval",
          approvals: approvalResults,
          otid: crypto.randomUUID(),
        },
      ]);
      const consumedQueuedTurn = consumeQueuedTurn(runtime);
      if (consumedQueuedTurn) {
        const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
        continuationInput = appendQueuedTurnToInput(
          continuationInput,
          queuedTurn,
        );
        emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
      }

      const continuationMessagesWithSkillContent = injectQueuedSkillContent(
        continuationInput.messages,
      );
      const recoverySendResult = await sendApprovalContinuationWithRetry(
        recoveryConversationId,
        continuationMessagesWithSkillContent,
        {
          agentId: runtime.agentId ?? undefined,
          streamTokens: true,
          background: true,
          workingDirectory: recoveryWorkingDirectory,
          preparedToolContext: preparedToolContext.preparedToolContext,
          ...(continuationInput.imageFailureModesByMessageOtid
            ? {
                imageFailureModesByMessageOtid:
                  continuationInput.imageFailureModesByMessageOtid,
              }
            : {}),
        },
        socket,
        runtime,
        turnLease,
        { allowApprovalRecovery: false },
      );
      assertCurrentTurnLease();
      if (recoverySendResult.kind !== "stream") {
        throw new Error(
          "Approval recovery send resolved without a continuation stream",
        );
      }
      const recoveryStream = recoverySendResult.stream;

      setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", scope);

      const drainResult = await drainRecoveryStreamWithEmission(
        recoveryStream as Stream<LettaStreamingResponse>,
        socket,
        runtime,
        {
          agentId: runtime.agentId ?? undefined,
          conversationId: recoveryConversationId,
          turnLease,
        },
      );
      assertCurrentTurnLease();

      if (drainResult.stopReason === "error") {
        throw new Error("Pre-stream approval recovery drain ended with error");
      }
      if (drainResult.stopReason !== "requires_approval") {
        return drainResult;
      }
      pendingApprovals = drainResult.approvals || [];
    } finally {
      runtime.turnLifecycle.setExecutingToolCallIds(turnLease, []);
    }
  }

  return null;
}

/**
 * Wrap sendMessageStream with pre-stream error handling (retry/recovery).
 * Mirrors headless bidirectional mode's pre-stream error handling.
 */
export async function sendMessageStreamWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  turnLease: TurnLease,
  retryOptions: {
    providerFallback?: ProviderFallbackState;
  } = {},
): Promise<Awaited<ReturnType<typeof sendMessageStream>>> {
  const abortSignal = turnLease.signal;
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  let currentOpts = opts;
  const retriedAfterBlockingRunSettled = new Set<string>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    setTurnLoopStatus(runtime, turnLease, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.agentId,
      conversation_id: conversationId,
    });

    try {
      return await sendMessageStream(
        conversationId,
        messages,
        currentOpts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        if (abortSignal?.aborted) throw new Error("Cancelled by user");

        if (
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          try {
            await resolveStaleApprovals(runtime, socket, turnLease);
            continue;
          } catch (_recoveryError) {
            if (abortSignal.aborted) throw new Error("Cancelled by user");
          }
        }

        const runErrorInfo = await fetchRunErrorInfo(runtime.activeRunId);
        throw Object.assign(
          new Error(
            runErrorInfo?.detail ||
              runErrorInfo?.message ||
              `Pre-stream approval conflict after ${preStreamRecoveryAttempts} recovery attempts`,
          ),
          { runErrorInfo },
        );
      }

      if (action === "retry_transient") {
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
        transientRetries = attempt;
        const fallbackHandle = maybeApplyProviderFallback(
          retryOptions.providerFallback,
          attempt,
        );
        if (fallbackHandle) {
          currentOpts = { ...currentOpts, overrideModel: fallbackHandle };
          emitRecoverableRetryNotice(socket, runtime, {
            kind: "transient_provider_retry",
            message: PROVIDER_FALLBACK_NOTICE,
            reason: "llm_api_error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs: 0,
            agentId: runtime.agentId ?? undefined,
            conversationId,
          });
          continue;
        }

        const retryAfterMs =
          preStreamError instanceof APIError
            ? parseRetryAfterHeaderMs(
                preStreamError.headers?.get("retry-after"),
              )
            : null;
        const delayMs = getRetryDelayMs({
          category: "transient_provider",
          attempt,
          detail: errorDetail,
          retryAfterMs,
        });

        const retryMessage = getRetryStatusMessage(errorDetail);
        if (retryMessage) {
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            agentId: runtime.agentId ?? undefined,
            conversationId,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      const blockingRunId = extractConversationBusyRunId(errorDetail);

      if (action === "retry_conversation_busy" || blockingRunId) {
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        const resumeStream = await tryResumeBusyConversationStream({
          conversationId,
          messages,
          runtime,
          abortSignal,
          debugMessage:
            "[Listen] Pre-stream resume failed, falling back to wait/retry:",
        });
        if (resumeStream) {
          return resumeStream;
        }

        const retryBudgetAvailable = action === "retry_conversation_busy";
        const attempt = conversationBusyRetries + 1;
        if (retryBudgetAvailable) {
          conversationBusyRetries = attempt;
        }
        const delayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt,
        });
        const retryNotice = getConversationBusyRetryNotice(
          blockingRunId,
          delayMs,
        );

        emitRetryDelta(socket, runtime, {
          message: retryNotice.message,
          reason: "error",
          attempt,
          maxAttempts: MAX_CONVERSATION_BUSY_RETRIES,
          delayMs: retryNotice.delayMs,
          agentId: runtime.agentId ?? undefined,
          conversationId,
        });

        const blockingRunDisposition = await maybeWaitForBlockingRun({
          runId: blockingRunId,
          retriedAfterSettled: retriedAfterBlockingRunSettled,
          abortSignal,
        });
        if (blockingRunDisposition === "retry_now") {
          continue;
        }
        if (!retryBudgetAvailable) {
          throw preStreamError;
        }

        await sleepWithAbort(delayMs, abortSignal);
        continue;
      }

      throw preStreamError;
    }
  }
}

export async function sendApprovalContinuationWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  turnLease: TurnLease,
  retryOptions: {
    allowApprovalRecovery?: boolean;
    providerFallback?: ProviderFallbackState;
  } = {},
): Promise<ApprovalContinuationSendResult> {
  const abortSignal = turnLease.signal;
  const allowApprovalRecovery = retryOptions.allowApprovalRecovery ?? true;
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  let currentOpts = opts;
  const retriedAfterBlockingRunSettled = new Set<string>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    setTurnLoopStatus(runtime, turnLease, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.agentId,
      conversation_id: conversationId,
    });

    try {
      const stream = await sendMessageStream(
        conversationId,
        messages,
        currentOpts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
      return { kind: "stream", stream };
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });

        if (
          allowApprovalRecovery &&
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          const drainResult = await resolveStaleApprovals(
            runtime,
            socket,
            turnLease,
          );
          if (drainResult) {
            return { kind: "terminal", drainResult };
          }
          continue;
        }

        const runErrorInfo = await fetchRunErrorInfo(runtime.activeRunId);
        throw Object.assign(
          new Error(
            runErrorInfo?.detail ||
              runErrorInfo?.message ||
              `Approval continuation conflict after ${preStreamRecoveryAttempts} recovery attempts`,
          ),
          { runErrorInfo },
        );
      }

      if (action === "retry_transient") {
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
        transientRetries = attempt;
        const fallbackHandle = maybeApplyProviderFallback(
          retryOptions.providerFallback,
          attempt,
        );
        if (fallbackHandle) {
          currentOpts = { ...currentOpts, overrideModel: fallbackHandle };
          emitRecoverableRetryNotice(socket, runtime, {
            kind: "transient_provider_retry",
            message: PROVIDER_FALLBACK_NOTICE,
            reason: "llm_api_error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs: 0,
            agentId: runtime.agentId ?? undefined,
            conversationId,
          });
          continue;
        }

        const retryAfterMs =
          preStreamError instanceof APIError
            ? parseRetryAfterHeaderMs(
                preStreamError.headers?.get("retry-after"),
              )
            : null;
        const delayMs = getRetryDelayMs({
          category: "transient_provider",
          attempt,
          detail: errorDetail,
          retryAfterMs,
        });

        const retryMessage = getRetryStatusMessage(errorDetail);
        if (retryMessage) {
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            agentId: runtime.agentId ?? undefined,
            conversationId,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      const blockingRunId = extractConversationBusyRunId(errorDetail);

      if (action === "retry_conversation_busy" || blockingRunId) {
        const retryBudgetAvailable = action === "retry_conversation_busy";
        const attempt = conversationBusyRetries + 1;
        if (retryBudgetAvailable) {
          conversationBusyRetries = attempt;
        }
        setTurnLoopStatus(runtime, turnLease, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });

        const resumeStream = await tryResumeBusyConversationStream({
          conversationId,
          messages,
          runtime,
          abortSignal,
          debugMessage:
            "[Listen] Approval continuation pre-stream resume failed, falling back to wait/retry:",
        });
        if (resumeStream) {
          return { kind: "stream", stream: resumeStream };
        }

        const retryDelayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt,
        });
        const retryNotice = getConversationBusyRetryNotice(
          blockingRunId,
          retryDelayMs,
        );

        emitRetryDelta(socket, runtime, {
          message: retryNotice.message,
          reason: "error",
          attempt,
          maxAttempts: MAX_CONVERSATION_BUSY_RETRIES,
          delayMs: retryNotice.delayMs,
          agentId: runtime.agentId ?? undefined,
          conversationId,
        });

        const blockingRunDisposition = await maybeWaitForBlockingRun({
          runId: blockingRunId,
          retriedAfterSettled: retriedAfterBlockingRunSettled,
          abortSignal,
        });
        if (blockingRunDisposition === "retry_now") {
          continue;
        }
        if (!retryBudgetAvailable) {
          throw preStreamError;
        }

        await sleepWithAbort(retryDelayMs, abortSignal);
        continue;
      }

      throw preStreamError;
    }
  }
}
