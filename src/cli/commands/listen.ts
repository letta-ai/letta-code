
import { hostname } from "node:os";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { settingsManager } from "@/settings-manager";
import { getErrorMessage } from "@/utils/error";
import { registerWithCloudRetry } from "@/websocket/listen-register";
import { resolveListenerRegistrationOptions } from "@/websocket/listener/auth";

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type CommandLine = Extract<Line, { kind: "command" }>;

let activeCommandId: string | null = null;

export function setActiveCommandId(id: string | null): void {
  activeCommandId = id;
}

export interface ListenCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
  agentId: string | null;
  conversationId: string | null;
}

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

export async function handleListen(
  ctx: ListenCommandContext,
  msg: string,
  opts: ListenOptions = {},
): Promise<void> {
  if (msg.trim() === "/remote off") {
    const { stopListenerClient, isListenerActive } = await import(
      "@/websocket/listen-client"
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

  if (msg.includes("--help") || msg.includes("-h")) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /server [--computer-name <name>]\n" +
        "       /server off\n\n" +
        "Register this computer to receive messages from Letta Cloud.\n" +
        "Alias: /remote\n\n" +
        "Options:\n" +
        "  --computer-name <name>  Friendly name for this computer (uses hostname if not provided)\n" +
        "  off                Stop the active listener connection\n" +
        "  -h, --help         Show this help message\n\n" +
        "Examples:\n" +
        "  /server                         # Start listener with hostname\n" +
        '  /server --computer-name "work-laptop" # Start with custom name\n' +
        "  /server off                     # Stop listening\n\n" +
        "Once connected, this instance will listen for incoming messages from cloud agents.\n" +
        "Messages will be executed locally on this computer.",
      true,
    );
    return;
  }

  let connectionName: string;

  if (opts.envName) {
    connectionName = opts.envName;
    settingsManager.setListenerEnvName(connectionName);
  } else {
    const savedName = settingsManager.getListenerEnvName();

    if (savedName) {
      connectionName = savedName;
    } else {
      connectionName = hostname();
      settingsManager.setListenerEnvName(connectionName);
    }
  }

  const buildConnectionUrl = (connId: string): string => {
    if (!ctx.agentId) return "";

    return buildAgentReference(ctx.agentId, {
      deviceId: connId,
      conversationId: ctx.conversationId ?? undefined,
    });
  };

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

    const resolveRegisterOptions = () =>
      resolveListenerRegistrationOptions(deviceId, connectionName, {
        allowInteractiveOAuth: false,
        surface: "listen",
      });

    const registerOptions = await resolveRegisterOptions();
    const {
      connectionId,
      wsUrl,
      supportsSplitStatusChannels,
      supportsPairedListenerGenerations,
    } = await registerWithCloudRetry(registerOptions, {
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
        `Computer: "${connectionName}"\n` +
        `WebSocket: ${wsUrl}\n\n` +
        `Starting WebSocket connection...`,
      true,
      "running",
    );

    const { startListenerClient } = await import("@/websocket/listen-client");

    const startClient = async (
      connId: string,
      wsUrlValue: string,
      nextSupportsSplitStatusChannels: boolean,
      nextSupportsPairedListenerGenerations: boolean,
      replacement?: import("@/websocket/listener/types").ListenerClientReplacement,
    ): Promise<void> => {
      await startListenerClient({
        replacement,
        connectionId: connId,
        wsUrl: wsUrlValue,
        supportsSplitStatusChannels: nextSupportsSplitStatusChannels,
        supportsPairedListenerGenerations:
          nextSupportsPairedListenerGenerations,
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
          const urlText = url ? `\n\nConnect to this computer:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Computer initialized: ${connectionName}\n${statusText}${urlText}`,
            true,
            "finished",
          );
        },
        onRetrying: (attempt, _maxAttempts, nextRetryIn, id) => {
          const url = buildConnectionUrl(id);
          const urlText = url ? `\n\nConnect to this computer:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Computer initialized: ${connectionName}\n` +
              `Reconnecting to Letta Cloud...\n` +
              `Attempt ${attempt}, retrying in ${Math.round(nextRetryIn / 1000)}s${urlText}`,
            true,
            "running",
          );
        },
        onConnected: (id) => {
          const url = buildConnectionUrl(id);
          const urlText = url ? `\n\nConnect to this computer:\n${url}` : "";

          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Computer initialized: ${connectionName}\nAwaiting instructions${urlText}`,
            true,
            "finished",
          );
          ctx.setCommandRunning(false);
        },
        onNeedsReregister: async (replacement) => {
          updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Computer connection expired, re-registering "${connectionName}"...`,
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

            await startClient(
              reregisterResult.connectionId,
              reregisterResult.wsUrl,
              reregisterResult.supportsSplitStatusChannels,
              reregisterResult.supportsPairedListenerGenerations,
              replacement,
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

    await startClient(
      connectionId,
      wsUrl,
      supportsSplitStatusChannels,
      supportsPairedListenerGenerations,
    );
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
