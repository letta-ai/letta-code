/**
 * Listen mode - Register letta-code as a listener to receive messages from Letta Cloud
 * Usage: letta listen --name "george"
 */

import { hostname } from "node:os";
import { getServerUrl } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import { getErrorMessage } from "../../utils/error";
import type { Buffers, Line } from "../helpers/accumulator";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

let activeCommandId: string | null = null;

export function setActiveCommandId(id: string | null): void {
  activeCommandId = id;
}

// Context passed to listen handler
export interface ListenCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
}

// Helper to add a command result to buffers
function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = activeCommandId ?? uid("cmd");
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  if (!buffersRef.current.order.includes(cmdId)) {
    buffersRef.current.order.push(cmdId);
  }
  refreshDerived();
  return cmdId;
}

// Helper to update an existing command result
function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

interface ListenOptions {
  name?: string;
  agentId?: string;
}

/**
 * Handle /listen command
 * Usage: /listen --name "george" [--agent agent-xyz]
 */
export async function handleListen(
  ctx: ListenCommandContext,
  msg: string,
  opts: ListenOptions = {},
): Promise<void> {
  // Show usage if needed
  if (msg.includes("--help") || msg.includes("-h")) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /listen --name <connection-name> [--agent <agent-id>]\n\n" +
        "Register this letta-code instance to receive messages from Letta Cloud.\n\n" +
        "Options:\n" +
        "  --name <name>      Friendly name for this connection (required)\n" +
        "  --agent <id>       Bind connection to specific agent (defaults to current agent)\n\n" +
        "Examples:\n" +
        '  /listen --name "george"                    # Uses current agent\n' +
        '  /listen --name "laptop-work" --agent agent-abc123\n\n' +
        "Once connected, this instance will listen for incoming messages from cloud agents.\n" +
        "Messages will be executed locally using your letta-code environment.",
      true,
    );
    return;
  }

  // Validate required parameters
  const connectionName = opts.name;
  const agentId = opts.agentId;

  if (!connectionName) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Error: --name is required\n\n" +
        'Usage: /listen --name "george"\n\n' +
        "Provide a friendly name to identify this connection (e.g., your name, device name).",
      false,
    );
    return;
  }

  if (!agentId) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Error: No agent specified\n\n" +
        "This connection needs a default agent to execute messages.\n" +
        "If you're seeing this, it means no agent is active in this conversation.\n\n" +
        "Please start a conversation with an agent first, or specify one explicitly:\n" +
        '  /listen --name "george" --agent agent-abc123',
      false,
    );
    return;
  }

  // Start listen flow
  ctx.setCommandRunning(true);

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Connecting to Letta Cloud...",
    true,
    "running",
  );

  try {
    // Get device ID (stable across sessions)
    const deviceId = settingsManager.getOrCreateDeviceId();
    const deviceName = hostname();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Registering listener "${connectionName}"...\n` +
        `Device: ${deviceName} (${deviceId.slice(0, 8)}...)`,
      true,
      "running",
    );

    // Register with cloud to get connectionId
    const serverUrl = getServerUrl();
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

    if (!apiKey) {
      throw new Error("Missing LETTA_API_KEY");
    }

    // Call register endpoint
    const registerUrl = `${serverUrl}/v1/listeners/register`;
    const registerResponse = await fetch(registerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Letta-Source": "letta-code",
      },
      body: JSON.stringify({
        deviceId,
        connectionName,
        agentId: opts.agentId,
      }),
    });

    if (!registerResponse.ok) {
      const error = (await registerResponse.json()) as { message?: string };
      throw new Error(error.message || "Registration failed");
    }

    const { connectionId, wsUrl } = (await registerResponse.json()) as {
      connectionId: string;
      wsUrl: string;
    };

    // Build agent info message
    const adeUrl = `https://app.letta.com/agents/${agentId}`;
    const agentInfo = `Agent: ${agentId}\n→ ${adeUrl}\n\n`;

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Registered successfully!\n\n` +
        `Connection ID: ${connectionId}\n` +
        `Name: "${connectionName}"\n` +
        agentInfo +
        `WebSocket: ${wsUrl}\n\n` +
        `Starting WebSocket connection...`,
      true,
      "running",
    );

    // Import and start WebSocket client
    const { startListenerClient } = await import(
      "../../websocket/listen-client"
    );

    await startListenerClient({
      connectionId,
      wsUrl,
      deviceId,
      connectionName,
      agentId,
      onStatusChange: (status, connId) => {
        const adeUrl = `https://app.letta.com/agents/${agentId}?deviceId=${connId}`;
        const statusText =
          status === "receiving"
            ? "Receiving message"
            : status === "processing"
              ? "Processing message"
              : "Awaiting instructions";

        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `Connected to Letta Cloud\n` +
            `${statusText}\n\n` +
            `View in ADE → ${adeUrl}`,
          true,
          "finished",
        );
      },
      onRetrying: (attempt, _maxAttempts, nextRetryIn) => {
        const adeUrl = `https://app.letta.com/agents/${agentId}?deviceId=${connectionId}`;
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `Reconnecting to Letta Cloud...\n` +
            `Attempt ${attempt}, retrying in ${Math.round(nextRetryIn / 1000)}s\n\n` +
            `View in ADE → ${adeUrl}`,
          true,
          "running",
        );
      },
      onConnected: () => {
        const adeUrl = `https://app.letta.com/agents/${agentId}?deviceId=${connectionId}`;

        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `Connected to Letta Cloud\n` +
            `Awaiting instructions\n\n` +
            `View in ADE → ${adeUrl}`,
          true,
          "finished",
        );
        ctx.setCommandRunning(false);
      },
      onDisconnected: () => {
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `✗ Listener disconnected\n\n` + `Connection to Letta Cloud was lost.`,
          false,
          "finished",
        );
        ctx.setCommandRunning(false);
      },
      onError: (error: Error) => {
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          `✗ Listener error: ${getErrorMessage(error)}`,
          false,
          "finished",
        );
        ctx.setCommandRunning(false);
      },
    });
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to start listener: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
    ctx.setCommandRunning(false);
  }
}
