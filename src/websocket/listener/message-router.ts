import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  estimateSystemPromptTokensFromMemoryDir,
  setSystemPromptDoctorState,
} from "../../cli/helpers/systemPromptWarning";
import { settingsManager } from "../../settings-manager";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import {
  handleTerminalInput,
  handleTerminalKill,
  handleTerminalResize,
  handleTerminalSpawn,
} from "../terminalHandler";
import { handleExecuteCommand } from "./commands";
import {
  handleChannelsProtocolCommand,
  isDetachedChannelsCommand,
} from "./commands/channels";
import { handleCronProtocolCommand } from "./commands/cron";
import { handleGitBranchCommand } from "./commands/git-branches";
import { handleMemoryProtocolCommand } from "./commands/memory";
import { handleModelToolsetCommand } from "./commands/model-toolset";
import { handleSecretsCommand } from "./commands/secrets";
import { handleSettingsProtocolCommand } from "./commands/settings";
import { handleSkillAgentProtocolCommand } from "./commands/skills-agents";
import {
  isExecuteCommandCommand,
  parseServerMessage,
} from "./protocol-inbound";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import {
  scheduleQueuePump,
  shouldProcessInboundMessageDirectly,
  shouldQueueInboundMessage,
} from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import {
  emitListenerStatus,
  getActiveRuntime,
  safeEmitWsEvent,
} from "./runtime";
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
    opts?: { recoverApprovals?: boolean },
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
};

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
  } = params;

  return async (data: WebSocket.RawData): Promise<void> => {
    const raw = data.toString();
    let parsedScope: ParsedRuntimeScope = null;

    try {
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

      if (parsed.type === "sync") {
        console.log(
          `[Listen V2] Received sync command for runtime=${parsed.runtime.agent_id}/${parsed.runtime.conversation_id}`,
        );
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping sync: runtime mismatch or closed`);
          return;
        }
        await replaySyncStateForRuntime(runtime, socket, parsed.runtime, {
          recoverApprovals: parsed.recover_approvals !== false,
        });
        return;
      }

      if (parsed.type === "input") {
        console.log(
          `[Listen V2] Received input command, kind=${parsed.payload?.kind}`,
        );
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
          scopedRuntime.messageQueue = scopedRuntime.messageQueue
            .then(async () => {
              if (
                runtime !== getActiveRuntime() ||
                runtime.intentionallyClosed
              ) {
                return;
              }
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              await handleIncomingMessage(
                directIncoming,
                socket,
                scopedRuntime,
                opts.onStatusChange,
                opts.connectionId,
              );
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              if (
                scopedRuntime.queueRuntime.length > 0 ||
                scopedRuntime.queuePumpScheduled ||
                scopedRuntime.queuePumpActive
              ) {
                scheduleQueuePump(
                  scopedRuntime,
                  socket,
                  opts,
                  processQueuedTurn,
                );
              }
            })
            .catch((error: unknown) => {
              trackListenerError(
                "listener_queued_input_failed",
                error,
                "listener_message_queue",
              );
              if (process.env.DEBUG) {
                console.error("[Listen] Error handling queued input:", error);
              }
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
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

          const firstUserPayload = stampedIncoming.messages.find(
            (
              payload,
            ): payload is MessageCreate & { client_message_id?: string } =>
              "content" in payload,
          );
          if (firstUserPayload) {
            const enqueuedItem = scopedRuntime.queueRuntime.enqueue({
              kind: "message",
              source: "user",
              content: firstUserPayload.content,
              clientMessageId:
                firstUserPayload.client_message_id ??
                `cm-submit-${crypto.randomUUID()}`,
              agentId: parsed.runtime.agent_id,
              conversationId: parsed.runtime.conversation_id || "default",
            } as Parameters<typeof scopedRuntime.queueRuntime.enqueue>[0]);
            if (enqueuedItem) {
              scopedRuntime.queuedMessagesByItemId.set(
                enqueuedItem.id,
                stampedIncoming,
              );
            }
          }
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
        await handleAbortMessageInput(runtime, {
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
        handleCronProtocolCommand(parsed, {
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
              const { getMemoryFilesystemRoot } = await import(
                "../../agent/memoryFilesystem"
              );
              const memoryDir = getMemoryFilesystemRoot(agentId);
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
            connectionId: opts.connectionId,
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
