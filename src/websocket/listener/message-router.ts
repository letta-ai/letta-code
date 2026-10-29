import type WebSocket from "ws";
import {
  estimateActiveMemorySystemPromptTokens,
  setSystemPromptDoctorState,
} from "@/cli/helpers/system-prompt-warning";
import { settingsManager } from "@/settings-manager";
import { isDebugEnabled } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import { sealStartupLogs } from "@/utils/startup-log-boundary";
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
import { handleBrowserDeviceMcpOAuthProtocolCommand } from "./commands/browser-device-mcp-oauth";
import { handleChatGPTResetCreditsCommand } from "./commands/chatgpt-reset-credits";
import { handleChatGPTUsageCommand } from "./commands/chatgpt-usage";
import { handleConnectProvidersCommand } from "./commands/connect-providers";
import { handleCronProtocolCommand } from "./commands/cron";
import { handleGitBranchCommand } from "./commands/git-branches";
import { handleMemfsSyncedMemoryProtocolCommand } from "./commands/memory-command-sync";
import { handleModelToolsetCommand } from "./commands/model-toolset";
import { handleQueueCommand } from "./commands/queue";
import { handleRuntimeStartProtocolCommand } from "./commands/runtime-start";
import { handleSecretsCommand } from "./commands/secrets";
import { handleSettingsProtocolCommand } from "./commands/settings";
import { handleSkillAgentProtocolCommand } from "./commands/skills-agents";
import {
  subscribeListenerConnection,
  waitForListenerConnectionStartup,
} from "./connection";
import { getBootWorkingDirectory } from "./cwd";
import {
  handleExternalToolCallResponseCommand,
  updateRuntimeExternalTools,
} from "./external-tools";
import { routeInputFrame } from "./input-frame-router";
import type {
  MessageRouterParams,
  ParsedRuntimeScope,
} from "./message-router-types";
import {
  isExecuteCommandCommand,
  parseServerLifecycleMessage,
  parseServerMessage,
} from "./protocol-inbound";
import { logV2Command, summarizeV2Command } from "./protocol-logging";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getActiveRuntime, safeEmitWsEvent } from "./runtime";
import { parseListenerReadyMessage } from "./split-stream-lifecycle";
import {
  handleTeleportFailure,
  handleTeleportProbe,
  handleTeleportRequest,
} from "./teleport";
import { handleIncomingMessage } from "./turn";
import { handleTurnFinishedAck } from "./turn-finished-ack";

export function createListenerMessageHandler(
  params: MessageRouterParams,
): (data: WebSocket.RawData) => Promise<void> {
  const {
    runtime,
    socket,
    connectionId: explicitConnectionId,
    lineageId: explicitLineageId,
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
  const lineageId =
    explicitLineageId ??
    runtime.connections.get(connectionId)?.startupOwner.lineageId ??
    connectionId ??
    runtime.sessionId;
  return async (data: WebSocket.RawData): Promise<void> => {
    if (
      !(await waitForListenerConnectionStartup(runtime, connectionId, socket))
    )
      return;

    const lifecycleMessage =
      parseListenerReadyMessage(data) ?? parseServerLifecycleMessage(data);
    // Seal before parsing; only projected pongs are content-free.
    if (lifecycleMessage?.type !== "pong") sealStartupLogs();
    let parsedScope: ParsedRuntimeScope = null;

    try {
      if (lifecycleMessage) {
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
        safeEmitWsEvent("recv", "lifecycle", {
          type: "_ws_unparseable",
        });
      }
      if (!parsed) {
        return;
      }

      logV2Command(opts, `Received ${summarizeV2Command(parsed)}`);

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

      if (parsed.type === "turn_finished_ack") {
        handleTurnFinishedAck(runtime, socket, connectionId, parsed);
        return;
      }

      if (
        parsed.type === "launch_subagent" ||
        parsed.type === "monitor_stop" ||
        parsed.type === "subagent_message" ||
        parsed.type === "subagent_stop"
      ) {
        const { handleTaskControlCommand } = await import(
          "./commands/task-control"
        );
        await handleTaskControlCommand(parsed, {
          runtime,
          socket,
          connectionId,
          getOrCreateScopedRuntime,
          runDetachedListenerTask,
          safeSocketSend,
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
          queuePumpOptions: opts,
          processQueuedTurn,
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
        handleTeleportFailure({
          listener: runtime,
          command: parsed,
          socket,
          connectionId,
          onStatusChange: opts.onStatusChange,
          getOrCreateScopedRuntime,
          runDetachedListenerTask,
          processIncomingMessage,
        });
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
          logV2Command(opts, "Dropping sync: runtime mismatch or closed");
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
            resumeInterruptedTurn: parsed.resume_interrupted_turn === true,
            forceDeviceStatus: parsed.force_device_status === true,
            onStatusChange: opts.onStatusChange,
            connectionId: opts.connectionId,
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
        await routeInputFrame({
          runtime,
          socket,
          connectionId,
          opts,
          parsed,
          processQueuedTurn,
          getOrCreateScopedRuntime,
          handleApprovalResponseInput,
          stampInboundUserMessageOtids,
          safeSocketSend,
          runDetachedListenerTask,
          trackListenerError,
          processIncomingMessage,
        });
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

      if (
        parsed.type === "resume_queue" ||
        parsed.type === "remove_queue_item"
      ) {
        handleQueueCommand(parsed, {
          listener: runtime,
          socket,
          opts,
          processQueuedTurn,
          getOrCreateScopedRuntime,
          safeSocketSend,
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
        handleChatGPTResetCreditsCommand(parsed, {
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
        }) ||
        handleBrowserDeviceMcpOAuthProtocolCommand(parsed, {
          socket,
          owner: runtime,
          lineageId,
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

      if (isExecuteCommandCommand(parsed)) {
        if (parsed.command_id === "refresh_doctor_state") {
          const agentId = parsed.runtime.agent_id;
          if (agentId && settingsManager.isMemfsEnabled(agentId)) {
            try {
              const { getScopedMemoryFilesystemRoot } = await import(
                "@/agent/memory-filesystem"
              );
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              const tokens = estimateActiveMemorySystemPromptTokens(memoryDir);
              setSystemPromptDoctorState(agentId, tokens);
            } catch {}
          }
          emitDeviceStatusUpdate(socket, runtime, parsed.runtime);
          return;
        }

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
