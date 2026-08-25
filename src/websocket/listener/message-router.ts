import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  estimateSystemPromptTokensFromMemoryDir,
  setSystemPromptDoctorState,
} from "@/cli/helpers/system-prompt-warning";
import { settingsManager } from "@/settings-manager";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  handleTerminalInput,
  handleTerminalKill,
  handleTerminalResize,
  handleTerminalSpawn,
} from "@/websocket/terminal-handler";
import { handleExecuteCommand } from "./commands";
import { handleAgentConversationManagementProtocolCommand } from "./commands/agents-conversations";
import { handleAppServerInfoCommand } from "./commands/app-server-info";
import { handleCwdProtocolCommand } from "./commands/boot-working-directory";
import { handleChatGPTUsageCommand } from "./commands/chatgpt-usage";
import { handleConnectProvidersCommand } from "./commands/connect-providers";
import { handleCronProtocolCommand } from "./commands/cron";
import { handleGitBranchCommand } from "./commands/git-branches";
import { handleMemfsSyncedMemoryProtocolCommand } from "./commands/memory-command-sync";
import { handleModelToolsetCommand } from "./commands/model-toolset";
import { handleRuntimeStartProtocolCommand } from "./commands/runtime-start";
import { handleSecretsCommand } from "./commands/secrets";
import { handleSettingsProtocolCommand } from "./commands/settings";
import { handleSkillAgentProtocolCommand } from "./commands/skills-agents";
import { subscribeListenerConnection } from "./connection";
import { getBootWorkingDirectory } from "./cwd";
import {
  handleExternalToolCallResponseCommand,
  updateRuntimeExternalTools,
} from "./external-tools";
import {
  dispatchInboundMessageWhenReady,
  getAcceptedInputDisposition,
  rememberAcceptedInputDisposition,
} from "./inbound-dispatch";
import {
  enqueueInboundUserMessage,
  getInboundClientMessageId,
} from "./inbound-queue";
import {
  isExecuteCommandCommand,
  parseServerLifecycleMessage,
  parseServerMessage,
} from "./protocol-inbound";
import { summarizeV2Command } from "./protocol-logging";
import {
  emitDeviceStatusUpdate,
  emitQueueUpdateIfOpen,
} from "./protocol-outbound";
import {
  scheduleQueuePump,
  shouldProcessInboundMessageDirectly,
  shouldQueueInboundMessage,
} from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getActiveRuntime, safeEmitWsEvent } from "./runtime";
import { parseListenerReadyMessage } from "./split-stream-lifecycle";
import {
  buildTeleportContinuationMessages,
  clearPriorReadyTeleports,
  handleTeleportProbe,
  handleTeleportRequest,
  isRuntimeTeleportPending,
  takeFailedTeleport,
} from "./teleport";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerConnectionId,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

type RunDetachedListenerTask = (
  commandName: string,
  task: () => Promise<void>,
) => void;

type TrackListenerError = (
  errorType: string,
  error: unknown,
  context: string,
) => void;

type FileCommandSession = {
  handle(parsed: unknown): boolean;
};
type RuntimeScope = {
  agent_id: string | null;
  conversation_id: string;
};

type ParsedRuntimeScope = RuntimeScope | null;

type MessageRouterParams = {
  runtime: ListenerRuntime;
  socket: WebSocket;
  connectionId?: ListenerConnectionId;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
  fileCommandSession: FileCommandSession;
  getParsedRuntimeScope: (parsed: unknown) => ParsedRuntimeScope;
  replaySyncStateForRuntime: (
    listenerRuntime: ListenerRuntime,
    socket: WebSocket,
    scope: RuntimeScope,
    opts?: { recoverApprovals?: boolean; forceDeviceStatus?: boolean },
  ) => Promise<void>;
  getOrCreateScopedRuntime: (
    listener: ListenerRuntime,
    agentId?: string | null,
    conversationId?: string | null,
  ) => ConversationRuntime;
  handleApprovalResponseInput: (
    listener: ListenerRuntime,
    params: {
      runtime: {
        agent_id?: string | null;
        conversation_id?: string | null;
      };
      response: ApprovalResponseBody;
      connectionId: ListenerConnectionId;
      socket: ListenerTransport;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  handleChangeDeviceStateInput: (
    listener: ListenerRuntime,
    params: {
      command: ChangeDeviceStateCommand;
      connectionId: ListenerConnectionId;
      socket: WebSocket;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  handleAbortMessageInput: (
    listener: ListenerRuntime,
    params: {
      command: AbortMessageCommand;
      connectionId: ListenerConnectionId;
      socket: WebSocket;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  stampInboundUserMessageOtids: (incoming: IncomingMessage) => IncomingMessage;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
  trackListenerError: TrackListenerError;
  processIncomingMessage?: typeof handleIncomingMessage;
};

export function createListenerMessageHandler(
  params: MessageRouterParams,
): (data: WebSocket.RawData) => Promise<void> {
  const {
    runtime,
    socket,
    connectionId: explicitConnectionId,
    opts,
    processQueuedTurn,
    fileCommandSession,
    getParsedRuntimeScope,
    replaySyncStateForRuntime,
    getOrCreateScopedRuntime,
    handleApprovalResponseInput,
    handleChangeDeviceStateInput,
    handleAbortMessageInput,
    stampInboundUserMessageOtids,
    safeSocketSend,
    runDetachedListenerTask,
    trackListenerError,
    processIncomingMessage = handleIncomingMessage,
  } = params;
  const connectionId = explicitConnectionId ?? opts.connectionId;

  return async (data: WebSocket.RawData): Promise<void> => {
    const raw = data.toString();
    let parsedScope: ParsedRuntimeScope = null;

    try {
      const lifecycleMessage =
        parseListenerReadyMessage(data) ?? parseServerLifecycleMessage(data);
      if (lifecycleMessage) {
        // Record relay pongs so the heartbeat watchdog can detect a half-open
        // socket (no pong within the timeout) and force a reconnect.
        if (lifecycleMessage.type === "pong") {
          runtime.lastPongAt = Date.now();
        }
        safeEmitWsEvent("recv", "lifecycle", lifecycleMessage);
        return;
      }

      const parsed = parseServerMessage(data);
      parsedScope = getParsedRuntimeScope(parsed);
      if (parsed) {
        safeEmitWsEvent("recv", "client", parsed);
      } else {
        // Log unparseable frames so protocol drift is visible in debug mode
        safeEmitWsEvent("recv", "lifecycle", {
          type: "_ws_unparseable",
          raw,
        });
      }
      if (isDebugEnabled()) {
        console.log(
          `[Listen] Received message: ${JSON.stringify(parsed, null, 2)}`,
        );
      }

      if (!parsed) {
        return;
      }

      console.log(`[Listen V2] Received ${summarizeV2Command(parsed)}`);

      if (parsedScope) {
        subscribeListenerConnection(runtime, connectionId, parsedScope);
      }

      if (parsed.type === "__invalid_input") {
        emitLoopErrorNotice(socket, runtime, {
          message: parsed.reason,
          stopReason: "error",
          isTerminal: false,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
        return;
      }

      if (parsed.type === "app_server_info") {
        handleAppServerInfoCommand(parsed, { socket, safeSocketSend });
        return;
      }

      if (
        handleRuntimeStartProtocolCommand(parsed, {
          socket,
          connectionId,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
          getOrCreateScopedRuntime,
          replaySyncStateForRuntime,
        })
      ) {
        return;
      }

      if (parsed.type === "teleport_probe") {
        handleTeleportProbe(parsed, socket, safeSocketSend);
        return;
      }

      if (parsed.type === "teleport_request") {
        handleTeleportRequest({
          listener: runtime,
          command: parsed,
          connectionId,
        });
        return;
      }

      if (parsed.type === "teleport_failed") {
        const pending = takeFailedTeleport({
          listener: runtime,
          teleportId: parsed.teleport_id,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
        const approvals = pending?.continuation?.approvals;
        if (pending && approvals && approvals.length > 0) {
          const scopedRuntime = getOrCreateScopedRuntime(
            runtime,
            pending.agentId,
            pending.conversationId,
          );
          runDetachedListenerTask("teleport_failed", async () => {
            await processIncomingMessage(
              {
                type: "message",
                connectionId: pending.connectionId,
                agentId: pending.agentId,
                conversationId: pending.conversationId,
                messages: [
                  {
                    type: "approval",
                    approvals,
                    otid: parsed.teleport_id,
                  },
                ],
              },
              socket,
              scopedRuntime,
              opts.onStatusChange,
              pending.connectionId,
            );
          });
        }
        return;
      }

      if (parsed.type === "external_tool_call_response") {
        handleExternalToolCallResponseCommand(runtime, connectionId, parsed);
        return;
      }

      if (parsed.type === "runtime_external_tools_update") {
        const respond = (success: boolean, error?: string): void => {
          safeSocketSend(
            socket,
            {
              type: "runtime_external_tools_update_response",
              request_id: parsed.request_id,
              success,
              ...(error ? { error } : {}),
            },
            "runtime_external_tools_update_response",
            "runtime_external_tools_update",
          );
        };
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          respond(false, "Runtime is no longer active");
          return;
        }
        updateRuntimeExternalTools(runtime, connectionId, parsed.updates);
        respond(true);
        return;
      }

      if (parsed.type === "sync") {
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping sync: runtime mismatch or closed`);
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "sync_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                success: false,
                error: "Runtime is no longer active",
              },
              "sync_response",
              "sync",
            );
          }
          return;
        }
        try {
          await replaySyncStateForRuntime(runtime, socket, parsed.runtime, {
            recoverApprovals: parsed.recover_approvals !== false,
            forceDeviceStatus: parsed.force_device_status === true,
          });
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "sync_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                success: true,
              },
              "sync_response",
              "sync",
            );
          }
        } catch (error) {
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "sync_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                success: false,
                error: getErrorMessage(error),
              },
              "sync_response",
              "sync",
            );
            return;
          }
          throw error;
        }
        return;
      }

      if (parsed.type === "input") {
        const acknowledgeInput = (
          accepted: boolean,
          error?: string,
          disposition?: "started" | "queued",
        ): void => {
          if (!parsed.request_id) return;
          safeSocketSend(
            socket,
            {
              type: "input_accepted",
              request_id: parsed.request_id,
              runtime: parsed.runtime,
              accepted,
              ...(disposition ? { disposition } : {}),
              ...(error ? { error } : {}),
            },
            "input_accepted_response",
            "input",
          );
        };
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping input: runtime mismatch or closed`);
          acknowledgeInput(false, "Runtime is no longer active");
          return;
        }
        if (parsed.payload.kind === "teleport_continue") {
          const teleportAgentId = parsed.runtime.agent_id;
          if (!teleportAgentId) {
            acknowledgeInput(
              false,
              "Teleport requires an agent-backed runtime",
            );
            return;
          }
          const teleportId = parsed.payload.teleport_id;
          clearPriorReadyTeleports({
            listener: runtime,
            agentId: teleportAgentId,
            conversationId: parsed.runtime.conversation_id,
            currentTeleportId: teleportId,
          });
          const scopedRuntime = getOrCreateScopedRuntime(
            runtime,
            parsed.runtime.agent_id,
            parsed.runtime.conversation_id,
          );
          const acceptedKey = `teleport:${teleportId}`;
          const previousDisposition =
            scopedRuntime.acceptedInputDispositions.get(acceptedKey);
          if (previousDisposition) {
            acknowledgeInput(true, undefined, previousDisposition);
            return;
          }
          const approvals = parsed.payload.continuation?.approvals;
          if (!approvals || approvals.length === 0) {
            acknowledgeInput(true);
            return;
          }
          if (scopedRuntime.isProcessing) {
            acknowledgeInput(
              false,
              "Destination runtime is already processing",
            );
            return;
          }
          scopedRuntime.acceptedInputDispositions.set(acceptedKey, "started");
          acknowledgeInput(true, undefined, "started");
          runDetachedListenerTask("teleport_continue", async () => {
            await processIncomingMessage(
              {
                type: "message",
                connectionId,
                agentId: teleportAgentId,
                conversationId: parsed.runtime.conversation_id,
                messages: buildTeleportContinuationMessages({
                  teleportId,
                  approvals,
                }),
              },
              socket,
              scopedRuntime,
              opts.onStatusChange,
              connectionId,
            );
          });
          return;
        }
        if (parsed.payload.kind === "approval_response") {
          const handled = await handleApprovalResponseInput(runtime, {
            runtime: parsed.runtime,
            response: parsed.payload,
            connectionId,
            socket,
            opts: {
              onStatusChange: opts.onStatusChange,
              connectionId: opts.connectionId,
            },
            processQueuedTurn,
          });
          acknowledgeInput(
            handled,
            handled ? undefined : "Approval request is no longer pending",
          );
          return;
        }
        const inputPayload = parsed.payload;
        if (inputPayload.kind !== "create_message") {
          emitLoopErrorNotice(socket, runtime, {
            message: `Unsupported input payload kind: ${String((inputPayload as { kind?: unknown }).kind)}`,
            stopReason: "error",
            isTerminal: false,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id,
          });
          acknowledgeInput(false, "Unsupported input payload kind");
          return;
        }
        const incoming: IncomingMessage = {
          type: "message",
          connectionId,
          ...(parsed.runtime.agent_id
            ? { agentId: parsed.runtime.agent_id }
            : {}),
          conversationId: parsed.runtime.conversation_id,
          clientToolAllowlist: inputPayload.client_tool_allowlist,
          clientToolset: inputPayload.client_toolset,
          externalToolScopeIds: inputPayload.external_tool_scope_ids,
          excludeInteractiveTools: inputPayload.exclude_interactive_tools,
          imageFailureMode: inputPayload.image_failure_mode,
          messages: inputPayload.messages,
        };
        const hasApprovalPayload = incoming.messages.some(
          (payload): payload is ApprovalCreate =>
            "type" in payload && payload.type === "approval",
        );
        if (hasApprovalPayload) {
          emitLoopErrorNotice(socket, runtime, {
            message:
              "Protocol violation: approval payloads are not allowed in input.kind=create_message. Use input.kind=approval_response.",
            stopReason: "error",
            isTerminal: false,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id,
          });
          acknowledgeInput(
            false,
            "Approval payloads require approval_response",
          );
          return;
        }

        const scopedRuntime = getOrCreateScopedRuntime(
          runtime,
          incoming.agentId,
          incoming.conversationId,
        );

        const processIncomingMessageDirectly = (
          directIncoming: IncomingMessage,
        ): void => {
          dispatchInboundMessageWhenReady({
            listener: runtime,
            runtime: scopedRuntime,
            incoming: directIncoming,
            socket,
            options: opts,
            processQueuedTurn,
            processIncomingMessage,
            actingUserId: parsed.runtime.acting_user_id,
            trackListenerError,
            onInputAccepted: ({ accepted, disposition }) =>
              acknowledgeInput(
                accepted,
                accepted ? undefined : "Input was rejected by the queue",
                disposition,
              ),
          });
        };

        if (shouldQueueInboundMessage(incoming)) {
          const stampedIncoming = stampInboundUserMessageOtids(incoming);
          const clientMessageId = getInboundClientMessageId(stampedIncoming);
          const acceptedDisposition = getAcceptedInputDisposition(
            scopedRuntime,
            clientMessageId,
          );
          if (acceptedDisposition) {
            acknowledgeInput(true, undefined, acceptedDisposition);
            return;
          }
          if (
            isRuntimeTeleportPending(
              runtime,
              scopedRuntime.agentId,
              scopedRuntime.conversationId,
            )
          ) {
            acknowledgeInput(false, "Conversation is switching computers");
            return;
          }
          if (
            shouldProcessInboundMessageDirectly(scopedRuntime, stampedIncoming)
          ) {
            processIncomingMessageDirectly(stampedIncoming);
            return;
          }

          const enqueued = enqueueInboundUserMessage(
            scopedRuntime,
            stampedIncoming,
            parsed.runtime.acting_user_id,
          );
          if (enqueued) {
            rememberAcceptedInputDisposition(
              scopedRuntime,
              clientMessageId,
              "queued",
            );
            scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          }
          acknowledgeInput(
            enqueued,
            enqueued ? undefined : "Input was rejected by the queue",
            enqueued ? "queued" : undefined,
          );
          return;
        }

        processIncomingMessageDirectly(incoming);
        return;
      }

      if (parsed.type === "change_device_state") {
        await handleChangeDeviceStateInput(runtime, {
          command: parsed,
          connectionId,
          socket,
          opts: {
            onStatusChange: opts.onStatusChange,
            connectionId: opts.connectionId,
          },
          processQueuedTurn,
        });
        return;
      }

      if (parsed.type === "abort_message") {
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "abort_message_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                aborted: false,
                success: false,
                error: "Runtime is no longer active",
              },
              "abort_message_response",
              "abort_message",
            );
          }
          return;
        }
        try {
          const aborted = await handleAbortMessageInput(runtime, {
            command: parsed,
            connectionId,
            socket,
            opts: {
              onStatusChange: opts.onStatusChange,
              connectionId: opts.connectionId,
            },
            processQueuedTurn,
          });
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "abort_message_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                aborted,
                success: true,
              },
              "abort_message_response",
              "abort_message",
            );
          }
        } catch (error) {
          if (parsed.request_id) {
            safeSocketSend(
              socket,
              {
                type: "abort_message_response",
                request_id: parsed.request_id,
                runtime: parsed.runtime,
                aborted: false,
                success: false,
                error: getErrorMessage(error),
              },
              "abort_message_response",
              "abort_message",
            );
            return;
          }
          throw error;
        }
        return;
      }

      if (parsed.type === "remove_queue_item") {
        const scopedRuntime = getOrCreateScopedRuntime(
          runtime,
          parsed.runtime.agent_id,
          parsed.runtime.conversation_id || "default",
        );
        const removed = scopedRuntime.queueRuntime.removeItem(parsed.item_id);
        // Emit a response so the client knows if the item was found/removed
        safeSocketSend(
          socket,
          {
            type: "remove_queue_item_response",
            request_id: parsed.request_id,
            success: removed !== null,
            item_id: parsed.item_id,
          },
          "remove_queue_item_response",
          "remove_queue_item",
        );
        // Broadcast the authoritative queue snapshot even when the item was
        // NOT found: a consumer removing an already-drained item is holding
        // a stale queue copy, and this snapshot repairs it. (LET-11174)
        emitQueueUpdateIfOpen(runtime, {
          agent_id: parsed.runtime.agent_id,
          conversation_id: parsed.runtime.conversation_id,
        });
        return;
      }

      if (fileCommandSession.handle(parsed)) {
        return;
      }

      if (
        handleMemfsSyncedMemoryProtocolCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleModelToolsetCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
          getOrCreateScopedRuntime,
        })
      ) {
        return;
      }

      if (
        handleConnectProvidersCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleChatGPTUsageCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleCronProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleAgentConversationManagementProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      // Channels management commands (device/live management)
      if (runtime.serviceCommandTypes.has(parsed.type)) {
        runDetachedListenerTask("service_command", async () => {
          const serviceCommandHandler = runtime.serviceCommandHandler;
          if (!serviceCommandHandler) {
            throw new Error("ChannelGateway service is not ready");
          }
          const result = await serviceCommandHandler({
            kind: "protocol",
            command: parsed,
          });
          if (result.kind !== "protocol") {
            throw new Error("Service returned an invalid protocol response");
          }
          for (const response of result.messages) {
            safeSocketSend(
              socket,
              response,
              "listener_service_command_send_failed",
              "listener_service_command",
            );
          }
        });
        return;
      }

      if (
        handleSkillAgentProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        parsed.type === "get_cwd_map" ||
        parsed.type === "set_boot_working_directory"
      ) {
        await handleCwdProtocolCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
        });
        return;
      }

      if (
        handleSettingsProtocolCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      // Slash commands (execute_command)
      if (isExecuteCommandCommand(parsed)) {
        // Internal-only: refresh doctor state after recompile (no chat output)
        if (parsed.command_id === "refresh_doctor_state") {
          const agentId = parsed.runtime.agent_id;
          if (agentId && settingsManager.isMemfsEnabled(agentId)) {
            try {
              const { getScopedMemoryFilesystemRoot } = await import(
                "@/agent/memory-filesystem"
              );
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              const tokens = estimateSystemPromptTokensFromMemoryDir(memoryDir);
              setSystemPromptDoctorState(agentId, tokens);
            } catch {
              // best-effort
            }
          }
          emitDeviceStatusUpdate(socket, runtime, parsed.runtime);
          return;
        }

        // Slash commands need a scoped runtime for the conversation context
        const scopedRuntime = getOrCreateScopedRuntime(
          runtime,
          parsed.runtime.agent_id,
          parsed.runtime.conversation_id,
        );
        runDetachedListenerTask("execute_command", async () => {
          await handleExecuteCommand(parsed, socket, scopedRuntime, {
            onStatusChange: opts.onStatusChange,
            onLog: opts.onLog,
            connectionId: opts.connectionId,
            connectionName: opts.connectionName,
          });
        });
        return;
      }

      if (
        handleGitBranchCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleSecretsCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      // Terminal commands (no runtime scope required)
      if (parsed.type === "terminal_spawn") {
        handleTerminalSpawn(
          parsed,
          socket,
          parsed.cwd ?? getBootWorkingDirectory(runtime),
          connectionId,
        );
        return;
      }

      if (parsed.type === "terminal_input") {
        handleTerminalInput(parsed, connectionId);
        return;
      }

      if (parsed.type === "terminal_resize") {
        handleTerminalResize(parsed, connectionId);
        return;
      }

      if (parsed.type === "terminal_kill") {
        handleTerminalKill(parsed, connectionId);
      }
    } catch (error) {
      trackListenerError(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      if (isDebugEnabled()) {
        console.error("[Listen] Unhandled message handler error:", error);
      }

      if (!parsedScope) {
        return;
      }

      emitLoopErrorNotice(socket, runtime, {
        message:
          error instanceof Error
            ? error.message
            : "Failed to process listener message",
        stopReason: "error",
        isTerminal: false,
        agentId: parsedScope.agent_id,
        conversationId: parsedScope.conversation_id,
        error,
      });
    }
  };
}
