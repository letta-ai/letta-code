/**
 * Server mode - Register letta-code as a listener to receive messages from Letta Cloud
 * Usage: letta server --name "george"
 */

import { hostname } from "node:os";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { settingsManager } from "@/settings-manager";
import { getErrorMessage } from "@/utils/error";
import { registerWithCloudRetry } from "@/websocket/listen-register";
import { resolveListenerRegistrationOptions } from "@/websocket/listener/auth";
import { resolveListenerIdentity } from "@/websocket/listener/identity";
import {
  claimListenerLock,
  releaseListenerLock,
} from "@/websocket/listener/instance-lock";

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
 * Ownership handle for the CURRENT /listen session's single-run lock.
 * Terminal callbacks capture their own session's handle at creation time;
 * release compares the lock nonce, so a stale callback from a replaced
 * session can never delete the replacement's lock.
 */
let activeListenSession: {
  handle:
    | import("@/websocket/listener/instance-lock").ListenerLockHandle
    | null;
  connectionName: string;
} | null = null;

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
    const { stopListenerClient, hasListenerRuntime } = await import(
      "@/websocket/listen-client"
    );

    // hasListenerRuntime, NOT isListenerActive: during a reconnect the
    // transport is null but the runtime (and its retry loop) is alive —
    // refusing to stop in that state would leave the session running and
    // its single-run lock held.
    if (!hasListenerRuntime() && !activeListenSession) {
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
    // Release THIS session's lock generation so the configured listener
    // can start again (here or in another process).
    const endedSession = activeListenSession;
    activeListenSession = null;
    await releaseListenerLock(endedSession?.handle);
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
      "Usage: /server [--env-name <name>]\n" +
        "       /server off\n\n" +
        "Register this letta-code instance to receive messages from Letta Cloud.\n" +
        "Alias: /remote\n\n" +
        "Options:\n" +
        "  --env-name <name>  Friendly name for this environment (uses hostname if not provided)\n" +
        "  off                Stop the active listener connection\n" +
        "  -h, --help         Show this help message\n\n" +
        "Examples:\n" +
        "  /server                         # Start listener with hostname\n" +
        '  /server --env-name "work-laptop" # Start with custom name\n' +
        "  /server off                     # Stop listening\n\n" +
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

    return buildAgentReference(ctx.agentId, {
      deviceId: connId,
      conversationId: ctx.conversationId ?? undefined,
    });
  };

  // Reject a second concurrent /listen from this TUI. Silently replacing
  // the running session would strand its lock (same pid, unreclaimable
  // until the TUI exits) and suppress its terminal callbacks as stale.
  {
    const { hasListenerRuntime } = await import("@/websocket/listen-client");
    if (hasListenerRuntime() || activeListenSession) {
      addCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        msg,
        `✗ A listener is already running in this session${
          activeListenSession
            ? ` ("${activeListenSession.connectionName}")`
            : ""
        }.\n\nStop it first with /remote off, then start the new one.`,
        false,
      );
      return;
    }
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

  // THIS session's lock generation. Terminal callbacks capture this exact
  // handle: release is nonce-compared, so even if a stale callback fires
  // after a future session replaced the lock (same pid!), it cannot delete
  // the replacement's lock.
  let sessionHandle:
    | import("@/websocket/listener/instance-lock").ListenerLockHandle
    | null = null;
  const endThisSession = (): Promise<void> => {
    if (activeListenSession?.handle === sessionHandle) {
      activeListenSession = null;
    }
    return releaseListenerLock(sessionHandle);
  };

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

    // Stable explicit identity for this configured /listen listener
    // (LET-10085); the identity value is never name-derived.
    const identity = await resolveListenerIdentity(connectionName, {
      namespace: "listen",
    });

    // Single-run guard: the SAME configured /listen listener must not run
    // twice on this host (two TUIs racing one relay slot). Fails visibly —
    // never kills the incumbent. Released on /remote off, disconnect,
    // error, supersession, and startup failure below.
    const lock = await claimListenerLock(identity.listenerInstanceId);
    if (lock.kind === "held") {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `✗ Listener "${connectionName}" is already running on this machine (pid ${lock.holder.pid}).\n\n` +
          `Stop it first (/remote off in that session), or use a different --env-name.`,
        false,
        "finished",
      );
      ctx.setCommandRunning(false);
      return;
    }

    sessionHandle = lock.kind === "acquired" ? lock.handle : null;
    activeListenSession = { handle: sessionHandle, connectionName };

    const resolveRegisterOptions = () =>
      resolveListenerRegistrationOptions(deviceId, connectionName, {
        allowInteractiveOAuth: false,
        surface: "listen",
        listenerInstanceId: identity.listenerInstanceId,
      });

    // Register with cloud, retrying transient failures with a bounded backoff.
    const registerOptions = await resolveRegisterOptions();
    const { connectionId, wsUrl, supportsSplitStatusChannels } =
      await registerWithCloudRetry(registerOptions, {
        onRetry: (attempt, delayMs, error) => {
          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Registering listener "${connectionName}"...\n` +
              `Retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
            true,
            "running",
          );
        },
      });

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
    const { startListenerClient } = await import("@/websocket/listen-client");

    // Helper to start client with given connection details
    const startClient = async (
      connId: string,
      wsUrlValue: string,
      nextSupportsSplitStatusChannels: boolean,
    ): Promise<void> => {
      await startListenerClient({
        connectionId: connId,
        wsUrl: wsUrlValue,
        supportsSplitStatusChannels: nextSupportsSplitStatusChannels,
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
            const nextRegisterOptions = await resolveRegisterOptions();
            const reregisterResult = await registerWithCloudRetry(
              nextRegisterOptions,
              {
                maxDurationMs: Infinity,
                onRetry: (attempt, delayMs, error) => {
                  updateCommandResult(
                    ctx.buffersRef,
                    ctx.refreshDerived,
                    cmdId,
                    msg,
                    `Re-registering "${connectionName}"...\n` +
                      `Retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
                    true,
                    "running",
                  );
                },
              },
            );

            // Restart client with new connectionId
            await startClient(
              reregisterResult.connectionId,
              reregisterResult.wsUrl,
              reregisterResult.supportsSplitStatusChannels,
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
            // Terminal for this /listen session — free the configured
            // listener for a future start.
            void endThisSession();
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
          void endThisSession();
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
          void endThisSession();
        },
      });
    };

    await startClient(connectionId, wsUrl, supportsSplitStatusChannels);
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
    // Startup failed after the lock was acquired — release it so retrying
    // /listen (or another process) can claim the configured listener.
    await endThisSession();
  }
}
