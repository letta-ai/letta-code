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
import {
  handleChannelsProtocolCommand,
  isDetachedChannelsCommand,
} from "./commands/channels";
import { handleChatGPTUsageCommand } from "./commands/chatgpt-usage";
import { handleConnectProvidersCommand } from "./commands/connect-providers";
import { handleCronProtocolCommand } from "./commands/cron";
import { handleGitBranchCommand } from "./commands/git-branches";
import { handleMemoryProtocolCommand } from "./commands/memory";
import { handleModelToolsetCommand } from "./commands/model-toolset";
import { handleRuntimeStartProtocolCommand } from "./commands/runtime-start";
import { handleSecretsCommand } from "./commands/secrets";
import { handleSettingsProtocolCommand } from "./commands/settings";
import { handleSkillAgentProtocolCommand } from "./commands/skills-agents";
import { getExportedCwdMap } from "./cwd";
import { handleExternalToolCallResponseCommand } from "./external-tools";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  isExecuteCommandCommand,
  parseServerLifecycleMessage,
  parseServerMessage,
} from "./protocol-inbound";
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
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
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
  agent_id: string;
  conversation_id: string;
};

type ParsedRuntimeScope = RuntimeScope | null;

export type WireChannelIngress = (
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
) => Promise<void>;

type MessageRouterParams = {
  runtime: ListenerRuntime;
  socket: WebSocket;
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
  wireChannelIngress: WireChannelIngress;
  processIncomingMessage?: typeof handleIncomingMessage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatLogValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  return null;
}

function pushField(
  fields: string[],
  key: string,
  value: unknown,
  label = key,
): void {
  const formatted = formatLogValue(value);
  if (formatted !== null) {
    fields.push(`${label}=${formatted}`);
  }
}

function summarizeInputPayload(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const fields: string[] = [];
  pushField(fields, "kind", payload.kind);
  if (payload.kind === "create_message") {
    pushField(fields, "messages", payload.messages);
    pushField(fields, "client_tool_allowlist", payload.client_tool_allowlist);
    pushField(
      fields,
      "external_tool_scope_ids",
      payload.external_tool_scope_ids,
    );
  } else if (payload.kind === "approval_response") {
    pushField(fields, "request_id", payload.request_id);
    pushField(fields, "response", payload.response);
    pushField(
      fields,
      "selected_suggestion_ids",
      payload.selected_suggestion_ids,
    );
  }
  return fields;
}

function summarizeRuntimeStartCommand(
  command: Record<string, unknown>,
): string[] {
  const fields: string[] = [];
  pushField(fields, "agent_id", command.agent_id, "agent");
  pushField(fields, "conversation_id", command.conversation_id, "conversation");
  if (isRecord(command.create_agent)) fields.push("create_agent=true");
  if (isRecord(command.create_conversation)) {
    fields.push("create_conversation=true");
  }
  pushField(fields, "cwd", command.cwd);
  pushField(fields, "mode", command.mode);
  pushField(fields, "external_tools", command.external_tools);
  return fields;
}

function summarizeV2Command(parsed: unknown): string {
  if (!isRecord(parsed) || typeof parsed.type !== "string") return "unknown";
  const fields: string[] = [];
  const runtime = isRecord(parsed.runtime) ? parsed.runtime : null;
  if (runtime) {
    fields.push(
      `runtime=${runtime.agent_id ?? "<unknown>"}/${runtime.conversation_id ?? "<unknown>"}`,
    );
  }
  pushField(fields, "request_id", parsed.request_id);

  if (parsed.type === "input") {
    fields.push(...summarizeInputPayload(parsed.payload));
  } else if (
    parsed.type === "change_device_state" &&
    isRecord(parsed.payload)
  ) {
    pushField(fields, "mode", parsed.payload.mode);
    pushField(fields, "cwd", parsed.payload.cwd);
    pushField(fields, "agent_id", parsed.payload.agent_id);
    pushField(fields, "conversation_id", parsed.payload.conversation_id);
  } else if (parsed.type === "runtime_start") {
    fields.push(...summarizeRuntimeStartCommand(parsed));
  } else {
    for (const key of [
      "agent_id",
      "conversation_id",
      "task_id",
      "channel_id",
      "account_id",
      "route_id",
      "target_id",
      "pairing_id",
      "path",
      "file_path",
      "ref",
      "encoding",
      "query",
      "glob",
      "is_regex",
      "case_sensitive",
      "whole_word",
      "cwd",
      "mode",
      "run_id",
      "item_id",
      "terminal_id",
      "cols",
      "rows",
      "depth",
      "limit",
      "offset",
      "max_results",
      "context_lines",
      "include_files",
      "model_id",
      "model_handle",
      "toolset",
      "provider_name",
      "auth_method",
      "scope",
      "command_id",
      "args",
      "name",
      "cron",
      "recurring",
      "source",
      "replace_all",
      "expected_replacements",
      "recover_approvals",
      "force_device_status",
    ]) {
      pushField(fields, key, parsed[key]);
    }
  }

  if (parsed.type === "write_file" && typeof parsed.content === "string") {
    fields.push(`content_bytes=${Buffer.byteLength(parsed.content)}`);
  }
  if (
    parsed.type === "write_memory_file" &&
    typeof parsed.content === "string"
  ) {
    fields.push(`content_bytes=${Buffer.byteLength(parsed.content)}`);
  }
  if (parsed.type === "edit_file") {
    if (typeof parsed.old_string === "string") {
      fields.push(`old_bytes=${Buffer.byteLength(parsed.old_string)}`);
    }
    if (typeof parsed.new_string === "string") {
      fields.push(`new_bytes=${Buffer.byteLength(parsed.new_string)}`);
    }
  }
  if (parsed.type === "file_ops") {
    pushField(fields, "cg_entries", parsed.cg_entries);
    pushField(fields, "ops", parsed.ops);
    if (typeof parsed.document_content === "string") {
      fields.push(
        `document_bytes=${Buffer.byteLength(parsed.document_content)}`,
      );
    }
  }
  if (parsed.type === "terminal_input" && typeof parsed.data === "string") {
    fields.push(`data_bytes=${Buffer.byteLength(parsed.data)}`);
  }
  if (parsed.type === "execute_command") {
    pushField(fields, "command_id", parsed.command_id);
    pushField(fields, "args", parsed.args);
  }

  return fields.length > 0
    ? `${parsed.type} command (${fields.join(", ")})`
    : `${parsed.type} command`;
}

export function createListenerMessageHandler(
  params: MessageRouterParams,
): (data: WebSocket.RawData) => Promise<void> {
  const {
    runtime,
    socket,
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
    wireChannelIngress,
    processIncomingMessage = handleIncomingMessage,
  } = params;

  return async (data: WebSocket.RawData): Promise<void> => {
    const raw = data.toString();
    let parsedScope: ParsedRuntimeScope = null;

    try {
      const lifecycleMessage = parseServerLifecycleMessage(data);
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

      if (
        handleRuntimeStartProtocolCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
          getOrCreateScopedRuntime,
          replaySyncStateForRuntime,
        })
      ) {
        return;
      }

      if (parsed.type === "external_tool_call_response") {
        handleExternalToolCallResponseCommand(runtime, parsed);
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
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping input: runtime mismatch or closed`);
          return;
        }

        if (parsed.payload.kind === "approval_response") {
          if (
            await handleApprovalResponseInput(runtime, {
              runtime: parsed.runtime,
              response: parsed.payload,
              socket,
              opts: {
                onStatusChange: opts.onStatusChange,
                connectionId: opts.connectionId,
              },
              processQueuedTurn,
            })
          ) {
            return;
          }
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
          return;
        }

        const incoming: IncomingMessage = {
          type: "message",
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
          clientToolAllowlist: inputPayload.client_tool_allowlist,
          externalToolScopeIds: inputPayload.external_tool_scope_ids,
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
          });
        };

        if (shouldQueueInboundMessage(incoming)) {
          const stampedIncoming = stampInboundUserMessageOtids(incoming);
          if (
            shouldProcessInboundMessageDirectly(scopedRuntime, stampedIncoming)
          ) {
            processIncomingMessageDirectly(stampedIncoming);
            return;
          }

          enqueueInboundUserMessage(
            scopedRuntime,
            stampedIncoming,
            parsed.runtime.acting_user_id,
          );
          scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          return;
        }

        processIncomingMessageDirectly(incoming);
        return;
      }

      if (parsed.type === "change_device_state") {
        await handleChangeDeviceStateInput(runtime, {
          command: parsed,
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
        // Broadcast the updated queue so all connected clients see the change
        if (removed !== null) {
          emitQueueUpdateIfOpen(runtime, {
            agent_id: parsed.runtime.agent_id,
            conversation_id: parsed.runtime.conversation_id,
          });
        }
        return;
      }

      if (fileCommandSession.handle(parsed)) {
        return;
      }

      if (
        handleMemoryProtocolCommand(parsed, {
          socket,
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
      if (isDetachedChannelsCommand(parsed)) {
        runDetachedListenerTask("channels_command", async () => {
          await handleChannelsProtocolCommand(
            parsed,
            socket,
            runtime,
            opts,
            processQueuedTurn,
            runDetachedListenerTask,
            wireChannelIngress,
            safeSocketSend,
          );
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

      if (parsed.type === "get_cwd_map") {
        safeSocketSend(
          socket,
          {
            type: "get_cwd_map_response",
            request_id: parsed.request_id,
            success: true,
            cwd_map: getExportedCwdMap(runtime),
            boot_working_directory: runtime.bootWorkingDirectory,
          },
          "get_cwd_map_response",
          "get_cwd_map",
        );
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
          parsed.cwd ?? runtime.bootWorkingDirectory,
        );
        return;
      }

      if (parsed.type === "terminal_input") {
        handleTerminalInput(parsed);
        return;
      }

      if (parsed.type === "terminal_resize") {
        handleTerminalResize(parsed);
        return;
      }

      if (parsed.type === "terminal_kill") {
        handleTerminalKill(parsed);
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
