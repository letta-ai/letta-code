import { randomUUID } from "node:crypto";
import { settingsManager } from "@/settings-manager";
import type { StreamDelta } from "@/types/protocol_v2";
import {
  createToolLifecycleTracker,
  type ToolLifecycleCallback,
} from "@/websocket/app-server-openai-tools";
import { getOrCreateProcessTransport } from "@/websocket/listener/connection";
import { createConnectionTurnProcessor } from "@/websocket/listener/connection-lifecycle";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { dispatchInboundMessageWhenReady } from "@/websocket/listener/inbound-dispatch";
import {
  startLocalChannelListener,
  stopRuntime,
} from "@/websocket/listener/lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "@/websocket/listener/permission-mode";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { handleIncomingMessage } from "@/websocket/listener/turn";
import { registerTurnObserver } from "@/websocket/listener/turn-observers";
import type {
  IncomingMessage as ListenerIncomingMessage,
  ListenerRuntime,
  ListenerStreamObserver,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export type UserContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

export interface TurnOutcome {
  text: string;
  reasoning?: string;
  usage: OpenAiUsage;
  error: string | null;
}

export interface BridgeTurnMessage {
  role: "user" | "assistant";
  content: UserContentPart[];
  otid: string;
}

export interface RunTurnParams {
  agentId: string;
  conversationId: string;
  messages: BridgeTurnMessage[];
  correlationOtid: string;
  onAssistantText?: (text: string) => void;
  onReasoningText?: (text: string) => void;
  onToolEvent?: ToolLifecycleCallback;
  onLog?: (message: string) => void;
}

type RunTurnImpl = (params: RunTurnParams) => Promise<TurnOutcome>;

let runTurnImpl: RunTurnImpl = runTurnViaListenerRuntime;

export function __testSetRunTurnImpl(impl: RunTurnImpl | null): void {
  runTurnImpl = impl ?? runTurnViaListenerRuntime;
}

export function runBridgeTurn(params: RunTurnParams): Promise<TurnOutcome> {
  return runTurnImpl(params);
}

const OPENAI_TURN_TIMEOUT_MS = 15 * 60 * 1000;

let bridgeRuntimeStart: Promise<void> | null = null;
let bridgeOwnedRuntime: ListenerRuntime | null = null;

export function closeOpenAiBridgeRuntime(): void {
  const runtime = bridgeOwnedRuntime;
  bridgeOwnedRuntime = null;
  if (!runtime || runtime.intentionallyClosed) return;
  if (getActiveRuntime() !== runtime) return;
  stopRuntime(runtime, true);
  setActiveRuntime(null);
}

async function ensureListenerRuntime(
  onLog?: (message: string) => void,
): Promise<ListenerRuntime> {
  const active = getActiveRuntime();
  if (active && !active.intentionallyClosed) return active;

  bridgeRuntimeStart ??= startLocalChannelListener({
    connectionId: `openai-api-${randomUUID()}`,
    deviceId: settingsManager.getOrCreateDeviceId(),
    connectionName: "openai-api",
    onConnected: () => {},
    onError: (error) => {
      onLog?.(`OpenAI-compat runtime error: ${error.message}`);
    },
  }).finally(() => {
    bridgeRuntimeStart = null;
  });
  await bridgeRuntimeStart;

  const runtime = getActiveRuntime();
  if (!runtime || runtime.intentionallyClosed) {
    throw new Error("failed to start listener runtime for OpenAI-compat API");
  }
  bridgeOwnedRuntime = runtime;
  return runtime;
}

function extractDeltaText(delta: unknown): string {
  const content = (
    delta as { content?: string | Array<{ text?: string }> | null }
  ).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function extractReasoningText(delta: unknown): string {
  const reasoning = (
    delta as { reasoning?: string | Array<{ text?: string }> | null }
  ).reasoning;
  if (typeof reasoning === "string") return reasoning;
  if (Array.isArray(reasoning)) {
    return reasoning
      .map((part) =>
        part && typeof part === "object" && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("");
  }
  return extractDeltaText(delta);
}

async function runTurnViaListenerRuntime(
  params: RunTurnParams,
): Promise<TurnOutcome> {
  const listener = await ensureListenerRuntime(params.onLog);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    params.agentId,
    params.conversationId,
  );
  getOrCreateConversationPermissionModeStateRef(
    listener,
    params.agentId,
    params.conversationId,
  ).mode = "unrestricted";
  const socket: ListenerTransport = getOrCreateProcessTransport(listener);

  const dispatchOptions: StartListenerOptions = {
    connectionId: listener.connectionId ?? "openai-api",
    wsUrl: "",
    deviceId: settingsManager.getOrCreateDeviceId(),
    connectionName: listener.connectionName ?? "openai-api",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: (error) => {
      params.onLog?.(`OpenAI-compat turn error: ${error.message}`);
    },
  };

  const processQueuedTurn: ProcessQueuedTurn =
    createConnectionTurnProcessor(listener);

  return await new Promise<TurnOutcome>((resolve) => {
    let text = "";
    let reasoning = "";
    let usage: OpenAiUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let turnActive = false;
    let recordedError: string | null = null;
    let settled = false;
    let unregisterTurnObserver: () => void = () => {};
    const toolTracker = params.onToolEvent
      ? createToolLifecycleTracker(params.onToolEvent)
      : null;
    if (!listener.streamObservers) {
      listener.streamObservers = new Set();
    }
    const observers = listener.streamObservers;

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      if (error) toolTracker?.failPending(error);
      clearTimeout(timer);
      observers.delete(observer);
      unregisterTurnObserver();
      toolTracker?.dispose();
      resolve({ text, reasoning, usage, error });
    };

    const observer: ListenerStreamObserver = (message) => {
      if (message.type === "runtime_stopped") {
        finish(
          recordedError ??
            "server runtime was replaced while the request was in flight",
        );
        return;
      }
      if (message.runtime.agent_id !== params.agentId) return;
      if (message.runtime.conversation_id !== params.conversationId) return;
      if (!turnActive) return;
      if (message.type === "update_loop_status") {
        const status = (message as { loop_status?: { status?: string } })
          .loop_status?.status;
        if (status === "WAITING_ON_APPROVAL") {
          const note =
            "The agent attempted a tool call that requires interactive approval, which this API does not support.";
          toolTracker?.failPending(note);
          if (!text) {
            text = note;
            params.onAssistantText?.(note);
          }
          finish(null);
        }
        return;
      }
      if (message.type !== "stream_delta" || message.subagent_id) return;
      const delta = (message as { delta?: { message_type?: string } }).delta;
      if (!delta) return;
      toolTracker?.process(delta as StreamDelta);
      switch (delta.message_type) {
        case "reasoning_message": {
          const piece = extractReasoningText(delta);
          if (piece) {
            reasoning += piece;
            params.onReasoningText?.(piece);
          }
          return;
        }
        case "assistant_message": {
          const piece = extractDeltaText(delta);
          if (piece) {
            text += piece;
            recordedError = null;
            params.onAssistantText?.(piece);
          }
          return;
        }
        case "usage_statistics": {
          const stats = delta as {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            reasoning_tokens?: number;
          };
          usage = {
            prompt_tokens: stats.prompt_tokens ?? 0,
            completion_tokens: stats.completion_tokens ?? 0,
            total_tokens: stats.total_tokens ?? 0,
            ...(stats.reasoning_tokens !== undefined
              ? { reasoning_tokens: stats.reasoning_tokens }
              : {}),
          };
          return;
        }
        case "loop_error": {
          const loopError = delta as {
            is_terminal?: boolean;
            message?: string;
          };
          if (loopError.is_terminal !== false) {
            recordedError = loopError.message ?? "agent turn failed";
          }
          return;
        }
        case "error_message":
          recordedError =
            (delta as { message?: string }).message ?? "agent turn failed";
          return;
        default:
          return;
      }
    };
    observers.add(observer);
    unregisterTurnObserver = registerTurnObserver(params.correlationOtid, {
      onStarted: () => {
        turnActive = true;
      },
      onFinished: () => {
        finish(recordedError);
      },
    });
    const timer = setTimeout(
      () => finish(recordedError ?? "agent turn timed out"),
      OPENAI_TURN_TIMEOUT_MS,
    );

    const incoming: ListenerIncomingMessage = {
      type: "message",
      agentId: params.agentId,
      conversationId: params.conversationId,
      noCoalesce: true,
      processOwnedTurn: true,
      excludeInteractiveTools: true,
      messages: params.messages.map((message) =>
        message.otid === params.correlationOtid
          ? { ...message, client_message_id: params.correlationOtid }
          : message,
      ),
    };
    try {
      dispatchInboundMessageWhenReady({
        listener,
        runtime: scopedRuntime,
        incoming,
        socket,
        options: dispatchOptions,
        processQueuedTurn,
        onInputAccepted: ({ accepted }) => {
          if (!accepted) {
            finish("The API request was rejected before queue admission");
          }
        },
        processIncomingMessage: (
          incoming,
          incomingSocket,
          incomingRuntime,
          onStatusChange,
          _connectionId,
          batchId,
        ) =>
          handleIncomingMessage(
            incoming,
            incomingSocket,
            incomingRuntime,
            onStatusChange,
            undefined,
            batchId,
          ),
        trackListenerError: (errorType, error) => {
          params.onLog?.(
            `OpenAI-compat listener error (${errorType}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          finish(error instanceof Error ? error.message : String(error));
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
}
