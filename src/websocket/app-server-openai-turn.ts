import { randomUUID } from "node:crypto";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { dispatchInboundMessageWhenReady } from "@/websocket/listener/inbound-dispatch";
import { startLocalChannelListener } from "@/websocket/listener/lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "@/websocket/listener/permission-mode";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import {
  type ListenerTransport,
  LocalListenerTransport,
} from "@/websocket/listener/transport";
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
  usage: OpenAiUsage;
  error: string | null;
}

export interface BridgeTurnMessage {
  role: "user" | "assistant";
  content: UserContentPart[];
  otid: string;
}

interface RunTurnParams {
  agentId: string;
  conversationId: string;
  /** Full input for the turn: the newest message in stateful mode, or the
   * replayed client transcript in stateless mode. */
  messages: BridgeTurnMessage[];
  /** OTID of a message in this turn, used to correlate the listener turn
   * lifecycle with this request. */
  correlationOtid: string;
  onAssistantText?: (text: string) => void;
  onLog?: (message: string) => void;
}

type RunTurnImpl = (params: RunTurnParams) => Promise<TurnOutcome>;

let runTurnImpl: RunTurnImpl = runTurnViaListenerRuntime;

/** @internal Test seam mirroring __testSetBackend. */
export function __testSetRunTurnImpl(impl: RunTurnImpl | null): void {
  runTurnImpl = impl ?? runTurnViaListenerRuntime;
}

/** Stable entry point used by the HTTP handler; tests swap the impl. */
export function runBridgeTurn(params: RunTurnParams): Promise<TurnOutcome> {
  return runTurnImpl(params);
}

// ---------------------------------------------------------------------------
// Turn execution over the listener v2 runtime.
//
// The bridge runs turns through the same dispatch path as WebSocket clients
// (queueing → turn processor → tools/mods/permissions) and observes the
// resulting v2 protocol stream via the runtime's in-process stream
// observers, converting chat-completions requests into protocol inputs and
// protocol events back into chat-completions outputs — the HTTP analogue of
// a messaging channel.
// ---------------------------------------------------------------------------

const OPENAI_TURN_TIMEOUT_MS = 15 * 60 * 1000;

const bridgeTransport = new LocalListenerTransport();
let bridgeRuntimeStart: Promise<void> | null = null;

/**
 * Reuse the active listener runtime when one exists (a connected WS control
 * session or channels runtime); otherwise start a socket-free local runtime,
 * exactly like `letta server --channels` does. If a WS control client
 * connects later it replaces the bridge-owned runtime, and subsequent
 * requests transparently use the new active runtime.
 */
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

async function runTurnViaListenerRuntime(
  params: RunTurnParams,
): Promise<TurnOutcome> {
  const listener = await ensureListenerRuntime(params.onLog);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    params.agentId,
    params.conversationId,
  );
  // No interactive approver exists on this surface, so bridge conversations
  // run unrestricted (Hermes-style: the API is opt-in and bearer-gated and
  // exposes the agent's full toolset). Approvals that still arise finish the
  // turn with an explanatory reply instead of hanging.
  getOrCreateConversationPermissionModeStateRef(
    listener,
    params.agentId,
    params.conversationId,
  ).mode = "unrestricted";
  // Frames emitted for this turn also flow to any attached WS client; the
  // transport here is only the fallback destination when none is attached.
  const socket: ListenerTransport =
    listener.socket ?? listener.transport ?? bridgeTransport;

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

  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn,
    dequeuedBatch,
  ) => {
    const queuedScope = getOrCreateScopedRuntime(
      listener,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      socket,
      queuedScope,
      undefined,
      dispatchOptions.connectionId,
      dequeuedBatch.batchId,
    );
  };

  return await new Promise<TurnOutcome>((resolve) => {
    let text = "";
    let usage: OpenAiUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    // The request settles from ITS OWN turn's lifecycle (turn-observers,
    // keyed by OTID), never from raw stream events: stop_reason ends a
    // stream segment before the listener decides on retries/approvals, and
    // usage can arrive after it. Stream deltas are accumulated only while
    // this request's turn is active, so queued requests and WS-initiated
    // turns in the same conversation never bleed into this response.
    let turnActive = false;
    let recordedError: string | null = null;
    let settled = false;
    let unregisterTurnObserver: () => void = () => {};
    if (!listener.streamObservers) {
      listener.streamObservers = new Set();
    }
    const observers = listener.streamObservers;

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observers.delete(observer);
      unregisterTurnObserver();
      resolve({ text, usage, error });
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
        // The turn paused for interactive input this surface cannot provide.
        const status = (message as { loop_status?: { status?: string } })
          .loop_status?.status;
        if (status === "WAITING_ON_APPROVAL") {
          if (!text) {
            const note =
              "The agent attempted a tool call that requires interactive approval, which this API does not support.";
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
      switch (delta.message_type) {
        case "assistant_message": {
          const piece = extractDeltaText(delta);
          if (piece) {
            text += piece;
            // New assistant output after a recorded error means the
            // listener retried successfully; the error is stale.
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
          };
          usage = {
            prompt_tokens: stats.prompt_tokens ?? 0,
            completion_tokens: stats.completion_tokens ?? 0,
            total_tokens: stats.total_tokens ?? 0,
          };
          return;
        }
        case "loop_error": {
          // Recorded, not settled: the listener may still retry. The turn
          // lifecycle end decides the final outcome.
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
      messages: params.messages,
    };
    try {
      dispatchInboundMessageWhenReady({
        listener,
        runtime: scopedRuntime,
        incoming,
        socket,
        options: dispatchOptions,
        processQueuedTurn,
        processIncomingMessage: handleIncomingMessage,
        trackListenerError: (errorType, error) => {
          params.onLog?.(
            `OpenAI-compat listener error (${errorType}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
}
