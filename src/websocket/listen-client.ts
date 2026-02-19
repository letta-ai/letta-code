/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import {
  type ApprovalDecision,
  type ApprovalResult,
  executeApprovalBatch,
} from "../agent/approval-execution";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { sendMessageStream } from "../agent/message";
import { createBuffers } from "../cli/helpers/accumulator";
import { drainStreamWithResume } from "../cli/helpers/stream";
import { settingsManager } from "../settings-manager";
import { loadTools } from "../tools/manager";

interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  deviceId: string;
  connectionName: string;
  agentId?: string;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: Error) => void;
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
  onRetrying?: (
    attempt: number,
    maxAttempts: number,
    nextRetryIn: number,
  ) => void;
}

interface PingMessage {
  type: "ping";
}

interface PongMessage {
  type: "pong";
}

interface IncomingMessage {
  type: "message";
  agentId?: string;
  conversationId?: string;
  messages: Array<MessageCreate | ApprovalCreate>;
}

interface ResultMessage {
  type: "result";
  success: boolean;
  stopReason?: string;
}

interface RunStartedMessage {
  type: "run_started";
  runId: string;
}

type ServerMessage = PongMessage | IncomingMessage;
type ClientMessage = PingMessage | ResultMessage | RunStartedMessage;

type ListenerRuntime = {
  socket: WebSocket | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  messageQueue: Promise<void>;
};

type ApprovalSlot =
  | { type: "result"; value: ApprovalResult }
  | { type: "decision" };

// Listen mode supports one active connection per process.
let activeRuntime: ListenerRuntime | null = null;

const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

function createRuntime(): ListenerRuntime {
  return {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    messageQueue: Promise.resolve(),
  };
}

function clearRuntimeTimers(runtime: ListenerRuntime): void {
  if (runtime.reconnectTimeout) {
    clearTimeout(runtime.reconnectTimeout);
    runtime.reconnectTimeout = null;
  }
  if (runtime.heartbeatInterval) {
    clearInterval(runtime.heartbeatInterval);
    runtime.heartbeatInterval = null;
  }
}

function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  runtime.intentionallyClosed = true;
  clearRuntimeTimers(runtime);

  if (!runtime.socket) {
    return;
  }

  const socket = runtime.socket;
  runtime.socket = null;

  // Stale runtimes being replaced should not emit callbacks/retries.
  if (suppressCallbacks) {
    socket.removeAllListeners();
  }

  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function parseServerMessage(data: WebSocket.RawData): ServerMessage | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type === "pong" || parsed.type === "message") {
      return parsed as ServerMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function sendClientMessage(socket: WebSocket, payload: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function buildApprovalExecutionPlan(
  approvalMessage: ApprovalCreate,
  pendingApprovals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>,
): {
  slots: ApprovalSlot[];
  decisions: ApprovalDecision[];
} {
  const pendingByToolCallId = new Map(
    pendingApprovals.map((approval) => [approval.toolCallId, approval]),
  );

  const slots: ApprovalSlot[] = [];
  const decisions: ApprovalDecision[] = [];

  for (const approval of approvalMessage.approvals ?? []) {
    if (approval.type === "tool") {
      slots.push({ type: "result", value: approval as ToolReturn });
      continue;
    }

    if (approval.type !== "approval") {
      slots.push({
        type: "result",
        value: {
          type: "tool",
          tool_call_id: "unknown",
          tool_return: "Error: Unsupported approval payload",
          status: "error",
        },
      });
      continue;
    }

    const pending = pendingByToolCallId.get(approval.tool_call_id);

    if (approval.approve) {
      if (!pending) {
        slots.push({
          type: "result",
          value: {
            type: "tool",
            tool_call_id: approval.tool_call_id,
            tool_return: "Error: Pending approval not found",
            status: "error",
          },
        });
        continue;
      }

      decisions.push({
        type: "approve",
        approval: {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          toolArgs: pending.toolArgs || "{}",
        },
      });
      slots.push({ type: "decision" });
      continue;
    }

    decisions.push({
      type: "deny",
      approval: {
        toolCallId: approval.tool_call_id,
        toolName: pending?.toolName ?? "",
        toolArgs: pending?.toolArgs ?? "{}",
      },
      reason:
        typeof approval.reason === "string" && approval.reason.length > 0
          ? approval.reason
          : "Tool execution denied",
    });
    slots.push({ type: "decision" });
  }

  return { slots, decisions };
}

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Replace any existing runtime without stale callback leakage.
  if (activeRuntime) {
    stopRuntime(activeRuntime, true);
  }

  const runtime = createRuntime();
  activeRuntime = runtime;

  await connectWithRetry(runtime, opts);
}

/**
 * Connect to WebSocket with exponential backoff retry.
 */
async function connectWithRetry(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
  attempt: number = 0,
  startTime: number = Date.now(),
): Promise<void> {
  if (runtime !== activeRuntime || runtime.intentionallyClosed) {
    return;
  }

  const elapsedTime = Date.now() - startTime;

  if (attempt > 0) {
    if (elapsedTime >= MAX_RETRY_DURATION_MS) {
      opts.onError(new Error("Failed to connect after 5 minutes of retrying"));
      return;
    }

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    const maxAttempts = Math.ceil(
      Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
    );

    opts.onRetrying?.(attempt, maxAttempts, delay);

    await new Promise<void>((resolve) => {
      runtime.reconnectTimeout = setTimeout(resolve, delay);
    });

    runtime.reconnectTimeout = null;
    if (runtime !== activeRuntime || runtime.intentionallyClosed) {
      return;
    }
  }

  clearRuntimeTimers(runtime);

  if (attempt === 0) {
    await loadTools();
  }

  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);
  if (opts.agentId) {
    url.searchParams.set("agentId", opts.agentId);
  }

  const socket = new WebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  runtime.socket = socket;

  socket.on("open", () => {
    if (runtime !== activeRuntime || runtime.intentionallyClosed) {
      return;
    }

    runtime.hasSuccessfulConnection = true;
    opts.onConnected();

    runtime.heartbeatInterval = setInterval(() => {
      sendClientMessage(socket, { type: "ping" });
    }, 30000);
  });

  socket.on("message", (data: WebSocket.RawData) => {
    const parsed = parseServerMessage(data);
    if (!parsed || parsed.type !== "message") {
      return;
    }

    runtime.messageQueue = runtime.messageQueue
      .then(async () => {
        if (runtime !== activeRuntime || runtime.intentionallyClosed) {
          return;
        }

        opts.onStatusChange?.("receiving", opts.connectionId);
        await handleIncomingMessage(
          parsed,
          socket,
          opts.onStatusChange,
          opts.connectionId,
        );
        opts.onStatusChange?.("idle", opts.connectionId);
      })
      .catch((error: unknown) => {
        if (process.env.DEBUG) {
          console.error("[Listen] Error handling queued message:", error);
        }
        opts.onStatusChange?.("idle", opts.connectionId);
      });
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (runtime !== activeRuntime) {
      return;
    }

    if (process.env.DEBUG) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    runtime.socket = null;

    if (runtime.intentionallyClosed) {
      opts.onDisconnected();
      return;
    }

    // If we had connected before, restart backoff from zero for this outage window.
    const nextAttempt = runtime.hasSuccessfulConnection ? 0 : attempt + 1;
    const nextStartTime = runtime.hasSuccessfulConnection
      ? Date.now()
      : startTime;
    runtime.hasSuccessfulConnection = false;

    connectWithRetry(runtime, opts, nextAttempt, nextStartTime).catch(
      (error) => {
        opts.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  socket.on("error", (error: Error) => {
    if (process.env.DEBUG) {
      console.error("[Listen] WebSocket error:", error);
    }
    // Error triggers close(), which handles retry logic.
  });
}

/**
 * Handle an incoming message from the cloud.
 */
async function handleIncomingMessage(
  msg: IncomingMessage,
  socket: WebSocket,
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void,
  connectionId?: string,
): Promise<void> {
  try {
    const agentId = msg.agentId;
    const requestedConversationId = msg.conversationId;
    const conversationId = requestedConversationId ?? "default";

    if (!agentId) {
      return;
    }

    if (connectionId) {
      onStatusChange?.("processing", connectionId);
    }

    let messagesToSend: Array<MessageCreate | ApprovalCreate> = msg.messages;

    const firstMessage = msg.messages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    if (isApprovalMessage) {
      const approvalMessage = firstMessage as ApprovalCreate;
      const client = await getClient();
      const agent = await client.agents.retrieve(agentId);
      const resumeData = await getResumeData(
        client,
        agent,
        requestedConversationId,
      );

      const { slots, decisions } = buildApprovalExecutionPlan(
        approvalMessage,
        resumeData.pendingApprovals,
      );
      const decisionResults =
        decisions.length > 0 ? await executeApprovalBatch(decisions) : [];

      const rebuiltApprovals: ApprovalResult[] = [];
      let decisionResultIndex = 0;

      for (const slot of slots) {
        if (slot.type === "result") {
          rebuiltApprovals.push(slot.value);
          continue;
        }

        const next = decisionResults[decisionResultIndex];
        if (next) {
          rebuiltApprovals.push(next);
          decisionResultIndex++;
          continue;
        }

        rebuiltApprovals.push({
          type: "tool",
          tool_call_id: "unknown",
          tool_return: "Error: Missing approval execution result",
          status: "error",
        });
      }

      messagesToSend = [
        {
          type: "approval",
          approvals: rebuiltApprovals,
        },
      ];
    }

    const stream = await sendMessageStream(conversationId, messagesToSend, {
      agentId,
      streamTokens: true,
      background: true,
    });

    let runIdSent = false;

    const buffers = createBuffers(agentId);
    const result = await drainStreamWithResume(
      stream as Stream<LettaStreamingResponse>,
      buffers,
      () => {},
      undefined,
      undefined,
      ({ chunk }) => {
        const maybeRunId = (chunk as { run_id?: unknown }).run_id;
        if (!runIdSent && typeof maybeRunId === "string") {
          runIdSent = true;
          sendClientMessage(socket, {
            type: "run_started",
            runId: maybeRunId,
          });
        }
        return undefined;
      },
    );

    sendClientMessage(socket, {
      type: "result",
      success: result.stopReason === "end_turn",
      stopReason: result.stopReason,
    });
  } catch {
    sendClientMessage(socket, {
      type: "result",
      success: false,
      stopReason: "error",
    });
  }
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  if (!activeRuntime) {
    return;
  }

  const runtime = activeRuntime;
  activeRuntime = null;
  stopRuntime(runtime, true);
}
