import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import type { Line } from "@/cli/helpers/accumulator";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "@/reminders/engine";
import { buildListenReminderContext } from "@/reminders/listen-context";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import { debugWarn, isDebugEnabled } from "@/utils/debug";
import { detectShellContext } from "@/utils/shell-context";
import { getInboundImageFailureModes } from "./image-policy";
import { consumeInterruptQueue } from "./interrupts";
import {
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "./mod-adapter";
import type { ConversationPermissionModeState } from "./permission-mode";
import { emitListenerTurnStart } from "./turn-events";
import {
  createTurnInputState,
  ensureTurnInputMessageOtids,
  type TurnInputState,
} from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import {
  buildInboundUserTranscriptLines,
  trackListenerUserInput,
} from "./turn-transcript";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";
import {
  ensureListenerWarmStateForTurn,
  getListenerAgentStateForTurn,
  setListenerAgentWarmState,
} from "./warmup";

type PreparedToolContext = Awaited<
  ReturnType<typeof prepareToolExecutionContextForScope>
>;

export type ListenerTurnSetupResult =
  | { kind: "interrupted" }
  | { kind: "cancelled"; reason: string }
  | {
      kind: "ready";
      getCachedAgent: () => AgentState | null;
      turnInput: TurnInputState;
      inboundUserTranscriptLines: Line[];
      pendingNormalizationInterruptedToolCallIds: string[];
      preparedToolContext: PreparedToolContext;
    };

export async function prepareListenerTurn(params: {
  msg: IncomingMessage;
  runtime: ConversationRuntime;
  agentId: string;
  requestedConversationId?: string;
  conversationId: string;
  workingDirectory: string;
  permissionModeState: ConversationPermissionModeState;
  turnLease: TurnLease;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  connectionId?: string;
}): Promise<ListenerTurnSetupResult> {
  const {
    msg,
    runtime,
    agentId,
    requestedConversationId,
    conversationId,
    workingDirectory,
    permissionModeState,
    turnLease,
    onStatusChange,
    connectionId,
  } = params;
  const isInterrupted = () =>
    turnLease.signal.aborted || !runtime.turnLifecycle.isCurrent(turnLease);

  let listenAgentMetadata = await ensureListenerWarmStateForTurn(
    runtime.listener,
    { agentId, conversationId },
  );
  if (isInterrupted()) {
    return { kind: "interrupted" };
  }

  setCurrentAgentId(agentId);
  setCurrentAgentName(listenAgentMetadata?.name ?? null);
  setConversationId(conversationId);

  if (isDebugEnabled()) {
    console.log(
      `[Listen] Handling message: agentId=${agentId}, requestedConversationId=${requestedConversationId}, conversationId=${conversationId}`,
    );
  }
  if (connectionId) {
    onStatusChange?.("processing", connectionId);
  }

  trackListenerUserInput(msg.messages, "unknown");

  const messagesToSend: Array<MessageCreate | ApprovalCreate> = [];
  let queuedInterruptedToolCallIds: string[] = [];
  const consumed = consumeInterruptQueue(runtime, agentId, conversationId);
  if (consumed) {
    messagesToSend.push(consumed.approvalMessage);
    queuedInterruptedToolCallIds = consumed.interruptedToolCallIds;
  }
  messagesToSend.push(...ensureTurnInputMessageOtids(msg.messages));

  let inboundUserTranscriptLines =
    buildInboundUserTranscriptLines(messagesToSend);
  const firstMessage = msg.messages[0];
  const isApprovalMessage =
    firstMessage &&
    "type" in firstMessage &&
    firstMessage.type === "approval" &&
    "approvals" in firstMessage;
  let cachedAgent: AgentState | null = null;

  if (!isApprovalMessage) {
    try {
      try {
        // Served from the session warm cache (background-refreshed) instead of
        // a blocking per-turn retrieve; headless reuses its initial agent fetch
        // for the whole run loop the same way.
        cachedAgent = await getListenerAgentStateForTurn(
          runtime.listener,
          agentId,
        );
        if (cachedAgent) {
          const {
            ensureLettaCodeOriginTag,
            getMemoryPromptModeForAgent,
            scheduleManagedSystemPromptUpdate,
          } = await import("@/agent/system-prompt-versioning");
          const taggedAgent = await ensureLettaCodeOriginTag(cachedAgent);
          if (taggedAgent !== cachedAgent) {
            setListenerAgentWarmState(runtime.listener, taggedAgent);
          }
          cachedAgent = taggedAgent;
          scheduleManagedSystemPromptUpdate({
            agent: cachedAgent,
            memoryMode: getMemoryPromptModeForAgent(cachedAgent.id),
            onUpdated: (updatedAgent) => {
              cachedAgent = updatedAgent;
            },
          });
        }
      } catch (error) {
        debugWarn(
          "listen",
          `Failed to ensure Letta Code agent metadata for ${agentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (isInterrupted()) {
        return { kind: "interrupted" };
      }

      if (!runtime.reminderState.hasSentAgentInfo && cachedAgent) {
        listenAgentMetadata = {
          name: cachedAgent.name ?? null,
          description: cachedAgent.description ?? null,
          lastRunAt:
            (cachedAgent as { last_run_completion?: string | null })
              .last_run_completion ?? null,
          agent: cachedAgent,
        };
      }
      setCurrentAgentName(
        listenAgentMetadata?.name ?? cachedAgent?.name ?? null,
      );
      const { parts: reminderParts } = await buildSharedReminderParts(
        buildListenReminderContext({
          agentId,
          conversationId,
          agentName: listenAgentMetadata?.name ?? null,
          agentDescription: listenAgentMetadata?.description ?? null,
          agentLastRunAt: listenAgentMetadata?.lastRunAt ?? null,
          state: runtime.reminderState,
          workingDirectory,
          shellContext: detectShellContext(),
        }),
      );
      if (isInterrupted()) {
        return { kind: "interrupted" };
      }

      if (reminderParts.length > 0) {
        for (const message of messagesToSend) {
          if (
            "role" in message &&
            message.role === "user" &&
            "content" in message
          ) {
            message.content = prependReminderPartsToContent(
              message.content,
              reminderParts,
            );
            break;
          }
        }
      }
    } catch (error) {
      trackBoundaryError({
        errorType: "listener_reminder_build_failed",
        error,
        context: "listener_turn_reminders",
      });
      if (isDebugEnabled()) {
        console.error("[Listen] Failed to build reminder parts:", error);
      }
    }
  }
  if (isInterrupted()) {
    return { kind: "interrupted" };
  }

  const hasUserMessage = messagesToSend.some(
    (message) => "role" in message && message.role === "user",
  );
  const turnStartEmission = hasUserMessage
    ? await emitListenerTurnStart({
        agentId,
        conversationId,
        input: messagesToSend,
        runtime: runtime.listener,
        workingDirectory,
        permissionMode: permissionModeState.mode,
        cachedAgent,
      })
    : ({ cancelled: false, input: messagesToSend } as const);
  if (isInterrupted()) {
    return { kind: "interrupted" };
  }
  if (turnStartEmission.cancelled) {
    return { kind: "cancelled", reason: turnStartEmission.reason };
  }

  const currentInput = ensureTurnInputMessageOtids(turnStartEmission.input);
  const turnInput = createTurnInputState(
    currentInput,
    getInboundImageFailureModes({
      channelTurnSources: msg.channelTurnSources,
      messages: currentInput,
    }),
  );
  if (currentInput !== messagesToSend) {
    inboundUserTranscriptLines = buildInboundUserTranscriptLines(currentInput);
  }
  const modAdapters = await ensureListenerModAdaptersForAgent(
    runtime.listener,
    agentId,
  );
  const preparedToolContext = await prepareToolExecutionContextForScope({
    agentId,
    conversationId,
    clientToolAllowlist: msg.clientToolAllowlist,
    externalToolScopeIds: msg.externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    skillSources: runtime.skillSources,
    cachedAgent,
    channelTurnSources: msg.channelTurnSources,
    modAdapters,
    modEvents: createListenerModEvents(modAdapters),
  });
  if (isInterrupted()) {
    return { kind: "interrupted" };
  }

  runtime.currentToolset = preparedToolContext.toolset;
  runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
  runtime.currentLoadedTools =
    preparedToolContext.preparedToolContext.loadedToolNames;
  return {
    kind: "ready",
    getCachedAgent: () => cachedAgent,
    turnInput,
    inboundUserTranscriptLines,
    pendingNormalizationInterruptedToolCallIds: [
      ...queuedInterruptedToolCallIds,
    ],
    preparedToolContext,
  };
}
