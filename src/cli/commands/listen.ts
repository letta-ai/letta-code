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
  agentId: string | null;
  conversationId: string | null;
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
  envName?: string;
}

/**
 * Handle /listen command
 * Usage: /listen [--env-name "work-laptop"]
 *        /listen off
 */
export async function handleListen(
  ctx: ListenCommandContext,
  msg: string,
  opts: ListenOptions = {},
): Promise<void> {
  // Handle /listen off - stop the listener
  if (msg.trim() === "/remote off") {
    const { stopListenerClient, isListenerActive } = await import(
      "../../websocket/listen-client"
    );

    if (!isListenerActive()) {
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        "Listen mode is not active.",
        false,
      );
      return;
    }

    stopListenerClient();
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "✓ Listen mode stopped\n\nListener disconnected from Letta Cloud.",
      true,
    );
    return;
  }

  // Show usage if needed
  if (msg.includes("--help") || msg.includes("-h")) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /remote [--env-name <name>]\n" +
        "       /remote off\n\n" +
        "Register this letta-code instance to receive messages from Letta Cloud.\n\n" +
        "Options:\n" +
        "  --env-name <name>  Friendly name for this environment (uses hostname if not provided)\n" +
        "  off                Stop the active listener connection\n" +
        "  -h, --help         Show this help message\n\n" +
        "Examples:\n" +
        "  /remote                         # Start listener with hostname\n" +
        '  /remote --env-name "work-laptop" # Start with custom name\n' +
        "  /remote off                     # Stop listening\n\n" +
        "Once connected, this instance will listen for incoming messages from cloud agents.\n" +
        "Messages will be executed locally using your letta-code environment.",
      true,
    );
    return;
  }

  // Determine connection name
  let connectionName: string;

  if (opts.envName) {
    // Explicitly provided - use it and save to local project settings
    connectionName = opts.envName;
    settingsManager.setListenerEnvName(connectionName);
  } else {
    // Not provided - check saved local project settings
    const savedName = settingsManager.getListenerEnvName();

    if (savedName) {
      // Reuse saved name
      connectionName = savedName;
    } else {
      // No saved name - use hostname and save it
      connectionName = hostname();
      settingsManager.setListenerEnvName(connectionName);
    }
  }

  // Helper to build ADE connection URL
  const buildConnectionUrl = (connId: string): string => {
    if (!ctx.agentId) return "";

    let url = `https://app.letta.com/agents/${ctx.agentId}?deviceId=${connId}`;
    if (ctx.conversationId) {
      url += `&conversationId=${ctx.conversationId}`;
    }
    return url;
  };

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
    const registerUrl = `${serverUrl}/v1/environments/register`;
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
      }),
    });

    if (!registerResponse.ok) {
      let errorMessage = `Registration failed (HTTP ${registerResponse.status})`;
      try {
        const error = (await registerResponse.json()) as { message?: string };
        if (error.message) errorMessage = error.message;
      } catch {
        // Response body is not JSON (e.g. HTML error page from proxy)
        const text = await registerResponse.text().catch(() => "");
        if (text) errorMessage += `: ${text.slice(0, 200)}`;
      }
      throw new Error(errorMessage);
    }

    let registerBody: { connectionId: string; wsUrl: string };
    try {
      registerBody = (await registerResponse.json()) as typeof registerBody;
    } catch {
      throw new Error(
        "Registration endpoint returned non-JSON response — is the server running?",
      );
    }
    const { connectionId, wsUrl } = registerBody;

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Registered successfully!\n\n` +
        `Connection ID: ${connectionId}\n` +
        `Environment: "${connectionName}"\n` +
        `WebSocket: ${wsUrl}\n\n` +
        `Starting WebSocket connection...`,
      true,
      "running",
    );

    // Import and start WebSocket client
    const { startListenerClient } = await import(
      "../../websocket/listen-client"
    );

    // Helper to start client with given connection details
    const startClient = async (
      connId: string,
      wsUrlValue: string,
    ): Promise<void> => {
      await startListenerClient({
        connectionId: connId,
        wsUrl: wsUrlValue,
        deviceId,
        connectionName,
        onStatusChange: (status, id) => {
          const statusText =
            status === "receiving"
              ? "Receiving message"
              : status === "processing"
                ? "Processing message"
                : "Awaiting instructions";

          const url = buildConnectionUrl(id);
          const urlText = url ? `\n\nConnect to this environment:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Environment initialized: ${connectionName}\n${statusText}${urlText}`,
            true,
            "finished",
          );
        },
        onRetrying: (attempt, _maxAttempts, nextRetryIn, id) => {
          const url = buildConnectionUrl(id);
          const urlText = url ? `\n\nConnect to this environment:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Environment initialized: ${connectionName}\n` +
              `Reconnecting to Letta Cloud...\n` +
              `Attempt ${attempt}, retrying in ${Math.round(nextRetryIn / 1000)}s${urlText}`,
            true,
            "running",
          );
        },
        onConnected: (id) => {
          const url = buildConnectionUrl(id);
          const urlText = url ? `\n\nConnect to this environment:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Environment initialized: ${connectionName}\nAwaiting instructions${urlText}`,
            true,
            "finished",
          );
          ctx.setCommandRunning(false);
        },
        onNeedsReregister: async () => {
          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Environment expired, re-registering "${connectionName}"...`,
            true,
            "running",
          );

          try {
            // Re-register to get new connectionId
            const reregisterResponse = await fetch(registerUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "X-Letta-Source": "letta-code",
              },
              body: JSON.stringify({
                deviceId,
                connectionName,
              }),
            });

            if (!reregisterResponse.ok) {
              let errorMessage = `Re-registration failed (HTTP ${reregisterResponse.status})`;
              try {
                const error = (await reregisterResponse.json()) as {
                  message?: string;
                };
                if (error.message) errorMessage = error.message;
              } catch {
                const text = await reregisterResponse.text().catch(() => "");
                if (text) errorMessage += `: ${text.slice(0, 200)}`;
              }
              throw new Error(errorMessage);
            }

            let reregisterData: { connectionId: string; wsUrl: string };
            try {
              reregisterData =
                (await reregisterResponse.json()) as typeof reregisterData;
            } catch {
              throw new Error(
                "Re-registration endpoint returned non-JSON response — is the server running?",
              );
            }

            // Restart client with new connectionId
            await startClient(
              reregisterData.connectionId,
              reregisterData.wsUrl,
            );
          } catch (error) {
            updateCommandResult(
              ctx.buffersRef,
              ctx.refreshDerived,
              cmdId,
              msg,
              `✗ Re-registration failed: ${getErrorMessage(error)}`,
              false,
              "finished",
            );
            ctx.setCommandRunning(false);
          }
        },
        onDisconnected: () => {
          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `✗ Listener disconnected\n\n` +
              `Connection to Letta Cloud was lost.`,
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
    };

    await startClient(connectionId, wsUrl);
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
