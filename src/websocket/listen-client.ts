/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import WebSocket from "ws";
import {sendMessageStream} from "../agent/message";
import {createBuffers} from "../cli/helpers/accumulator";
import {drainStreamWithResume} from "../cli/helpers/stream";
import {settingsManager} from "../settings-manager";
import {loadTools} from "../tools/manager";

interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  deviceId: string;
  connectionName: string;
  agentId?: string;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: Error) => void;
  onStatusChange?: (status: "idle" | "receiving" | "processing", connectionId: string) => void;
}

// WebSocket message types
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
  messages: Array<{
    role: "user";
    content: string | Array<{ type: "text"; text: string }>;
    otid?: string;
  }>;
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

// Global WebSocket instance
let activeConnection: WebSocket | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Start the listener WebSocket client
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Close existing connection if any
  if (activeConnection) {
    activeConnection.close();
    activeConnection = null;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // CRITICAL: Load tools into registry before starting listener
  // This ensures getClientToolsFromRegistry() returns the full tool harness
  // when messages are executed via sendMessageStream()
  if (process.env.DEBUG) {
    console.log("[Listen] Loading tool registry...");
  }
  await loadTools();

  // Get API key for authentication
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  // Build WebSocket URL with query params
  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);
  if (opts.agentId) {
    url.searchParams.set("agentId", opts.agentId);
  }

  // Create WebSocket connection with auth
  const ws = new WebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  activeConnection = ws;

  // Handle connection open
  ws.on("open", () => {
    if (process.env.DEBUG) {
      console.log("[Listen] WebSocket connected");
    }
    opts.onConnected();

    // Start heartbeat ping every 30 seconds
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const pingMsg: ClientMessage = {type: "ping"};
        ws.send(JSON.stringify(pingMsg));
      }
    }, 30000);
  });

  // Handle incoming messages
  ws.on("message", async (data: Buffer) => {
    try {
      const msg: ServerMessage = JSON.parse(data.toString());

      if (msg.type === "pong") {
        // Heartbeat response - no action needed
        return;
      }

      if (msg.type === "message") {
        if (process.env.DEBUG) {
          console.log(
            `[Listen] Received message for agent ${msg.agentId || "default"}`,
          );
        }
        opts.onStatusChange?.("receiving", opts.connectionId);
        await handleIncomingMessage(msg, opts.onStatusChange, opts.connectionId);
        opts.onStatusChange?.("idle", opts.connectionId);
      }
    } catch (error) {
      if (process.env.DEBUG) {
        console.error("[Listen] Error handling message:", error);
      }
    }
  });

  // Handle connection close
  ws.on("close", () => {
    if (process.env.DEBUG) {
      console.log("[Listen] WebSocket disconnected");
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    activeConnection = null;
    opts.onDisconnected();
  });

  // Handle connection error
  ws.on("error", (error) => {
    if (process.env.DEBUG) {

      console.error("[Listen] WebSocket error:", error);
    }
    opts.onError(error);
  });
}

/**
 * Handle an incoming message from the cloud
 * Execute it locally using the letta-code harness
 */
async function handleIncomingMessage(
  msg: IncomingMessage,
  onStatusChange?: (status: "idle" | "receiving" | "processing", connectionId: string) => void,
  connectionId?: string,
): Promise<void> {
  try {
    const agentId = msg.agentId;
    const conversationId = msg.conversationId || "default";

    if (!agentId) {
      if (process.env.DEBUG) {

        console.error("[Listen] No agentId provided in message");
      }
      return;
    }

    if (process.env.DEBUG) {

      console.log(
        `[Listen] Executing message for agent ${agentId}, conversation ${conversationId}`,
      );
    }

    if (connectionId) {
      onStatusChange?.("processing", connectionId);
    }

    // Check if this is an approval message - need to execute tools locally
    const firstMessage = msg.messages[0];
    const isApprovalMessage = firstMessage && 'type' in firstMessage && firstMessage.type === 'approval';

    let messagesToSend = msg.messages;

    if (isApprovalMessage && 'approvals' in firstMessage) {
      if (process.env.DEBUG) {

        console.log(`[Listen] Processing approval message with ${firstMessage.approvals.length} approval(s)`);
      }

      const {getClient} = await import("../agent/client");
      const {executeTool} = await import("../tools/manager");
      const {getResumeData} = await import("../agent/check-approval");
      const client = await getClient();

      // Fetch agent and pending approvals
      const agent = await client.agents.retrieve(agentId);
      const resumeData = await getResumeData(
        client,
        agent,
        conversationId === "default" ? undefined : conversationId
      );
      const pendingApprovals = resumeData.pendingApprovals;

      // Execute approved tools locally and build ToolReturn messages
      const toolReturns = await Promise.all(
        firstMessage.approvals.map(async (approval: any) => {
          // If already a tool return, pass through
          if (approval.type === 'tool') {
            return approval;
          }

          // Handle approve: true by executing locally
          if (approval.approve === true) {
            const pending = pendingApprovals.find((p) => p.toolCallId === approval.tool_call_id);
            if (!pending) {
              if (process.env.DEBUG) {

                console.warn(`[Listen] No pending approval found for ${approval.tool_call_id}`);
              }
              return {
                type: 'tool',
                tool_call_id: approval.tool_call_id,
                tool_return: 'Error: Pending approval not found',
                status: 'error',
              };
            }

            if (process.env.DEBUG) {

              console.log(`[Listen] Executing tool locally: ${pending.toolName}`);
            }
            try {
              const result = await executeTool(
                pending.toolName,
                JSON.parse(pending.toolArgs || '{}'),
              );

              return {
                type: 'tool',
                tool_call_id: approval.tool_call_id,
                tool_return: result.toolReturn,
                status: result.status,
                stdout: result.stdout ? [result.stdout] : undefined,
                stderr: result.stderr ? [result.stderr] : undefined,
              };
            } catch (error) {
              return {
                type: 'tool',
                tool_call_id: approval.tool_call_id,
                tool_return: `Error: ${error instanceof Error ? error.message : String(error)}`,
                status: 'error',
              };
            }
          }

          // Denied - return error
          return {
            type: 'tool',
            tool_call_id: approval.tool_call_id,
            tool_return: approval.reason || 'Tool execution denied',
            status: 'error',
          };
        })
      );

      // Replace approvals with tool returns
      messagesToSend = [
        {
          type: 'approval',
          approvals: toolReturns,
        }
      ];
    }

    // Send message to core (either original or with executed tool returns)
    const stream = await sendMessageStream(conversationId, messagesToSend, {
      agentId,
      streamTokens: true,
      background: true,
    });

    // Capture runId from first stream chunk and send to cloud
    let runId: string | undefined;
    let runIdSent = false;

    // Wrap stream to intercept chunks
    const originalStream = stream;
    const interceptedChunks: any[] = [];

    for await (const chunk of originalStream) {
      interceptedChunks.push(chunk);

      // Extract runId from first chunk
      if (!runIdSent && 'run_id' in chunk && chunk.run_id) {
        runId = chunk.run_id;
        runIdSent = true;

        // Send runId back to cloud immediately
        if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
          const runStartedMsg: ClientMessage = {
            type: "run_started",
            runId,
          };
          activeConnection.send(JSON.stringify(runStartedMsg));
          if (process.env.DEBUG) {

            console.log(`[Listen] Sent runId to cloud: ${runId}`);
          }
        }
      }
    }

    // Process the collected chunks through drainStreamWithResume
    // We need to convert the array back to an async iterable
    async function* replayChunks() {
      for (const chunk of interceptedChunks) {
        yield chunk;
      }
    }

    const buffers = createBuffers(agentId);
    const result = await drainStreamWithResume(replayChunks() as any, buffers, () => {
    });

    if (process.env.DEBUG) {

      console.log(`[Listen] Execution complete. Stop reason: ${result.stopReason}`);
    }

    // Send result back to cloud (optional)
    if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
      const resultMsg: ClientMessage = {
        type: "result",
        success: result.stopReason === "end_turn",
        stopReason: result.stopReason,
      };
      activeConnection.send(JSON.stringify(resultMsg));
    }
  } catch (error) {
    if (process.env.DEBUG) {

      console.error("[Listen] Error executing message:", error);
    }

    // Send error result back
    if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
      const resultMsg: ClientMessage = {
        type: "result",
        success: false,
        stopReason: "error",
      };
      activeConnection.send(JSON.stringify(resultMsg));
    }
  }
}

/**
 * Stop the active listener connection
 */
export function stopListenerClient(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (activeConnection) {
    activeConnection.close();
    activeConnection = null;
  }
}
