/**
 * CLI subcommand: letta listen --name \"george\"
 * Register letta-code as a listener to receive messages from Letta Cloud
 */

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { Box, render, Text } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { getServerUrl } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import { RemoteSessionLog } from "../../websocket/listen-log";
import { registerWithCloud } from "../../websocket/listen-register";
import { ListenerStatusUI } from "../components/ListenerStatusUI";

/**
 * Interactive prompt for environment name
 */
function PromptEnvName(props: {
  onSubmit: (envName: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");

  return (
    <Box flexDirection="column">
      <Text>Enter environment name (or press Enter for hostname): </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(input) => {
          const finalName = input.trim() || hostname();
          props.onSubmit(finalName);
        }}
      />
    </Box>
  );
}

function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export async function runListenSubcommand(argv: string[]): Promise<number> {
  // Parse arguments
  const { values } = parseArgs({
    args: argv,
    options: {
      envName: { type: "string" },
      help: { type: "boolean", short: "h" },
      debug: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const debugMode = !!values.debug;

  // Show help
  if (values.help) {
    console.log("Usage: letta remote [--env-name <name>] [--debug]\n");
    console.log(
      "Register this letta-code instance to receive messages from Letta Cloud.\n",
    );
    console.log("Options:");
    console.log(
      "  --env-name <name>  Friendly name for this environment (uses hostname if not provided)",
    );
    console.log(
      "  --debug            Plain-text mode: log all WebSocket events instead of interactive UI",
    );
    console.log("  -h, --help         Show this help message\n");
    console.log("Examples:");
    console.log(
      "  letta remote                      # Uses hostname as default",
    );
    console.log('  letta remote --env-name "work-laptop"');
    console.log("  letta remote --debug              # Log all WS events\n");
    console.log(
      "Once connected, this instance will listen for incoming messages from cloud agents.",
    );
    console.log(
      "Messages will be executed locally using your letta-code environment.",
    );
    return 0;
  }

  // Load local project settings to access saved environment name
  await settingsManager.loadLocalProjectSettings();

  // Determine connection name
  let connectionName: string;

  if (values.envName) {
    // Explicitly provided - use it and save to local project settings
    connectionName = values.envName;
    settingsManager.setListenerEnvName(connectionName);
  } else {
    // Not provided - check saved local project settings
    const savedName = settingsManager.getListenerEnvName();

    if (savedName) {
      // Reuse saved name
      connectionName = savedName;
    } else if (debugMode) {
      // In debug mode, default to hostname without prompting
      connectionName = hostname();
      settingsManager.setListenerEnvName(connectionName);
    } else {
      // No saved name - prompt user
      connectionName = await new Promise<string>((resolve) => {
        const { unmount } = render(
          <PromptEnvName
            onSubmit={(name) => {
              unmount();
              resolve(name);
            }}
          />,
        );
      });

      // Save to local project settings for future runs
      settingsManager.setListenerEnvName(connectionName);
    }
  }

  // Session log (always written to ~/.letta/logs/remote/)
  const sessionLog = new RemoteSessionLog();
  sessionLog.init();
  console.log(`Log file: ${sessionLog.path}`);

  try {
    // Get device ID
    const deviceId = settingsManager.getOrCreateDeviceId();

    // Get API key (include secure token storage fallback)
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

    if (!apiKey) {
      console.error("Error: LETTA_API_KEY not found");
      console.error("Set your API key with: export LETTA_API_KEY=<your-key>");
      return 1;
    }

    sessionLog.log(`Session started (debug=${debugMode})`);
    sessionLog.log(`deviceId: ${deviceId}`);
    sessionLog.log(`connectionName: ${connectionName}`);

    // Register with cloud
    const serverUrl = getServerUrl();

    if (debugMode) {
      console.log(
        `[${formatTimestamp()}] Registering with ${serverUrl}/v1/environments/register`,
      );
      console.log(`[${formatTimestamp()}]   deviceId: ${deviceId}`);
      console.log(`[${formatTimestamp()}]   connectionName: ${connectionName}`);
    }
    sessionLog.log(`Registering with ${serverUrl}/v1/environments/register`);

    const { connectionId, wsUrl } = await registerWithCloud({
      serverUrl,
      apiKey,
      deviceId,
      connectionName,
    });

    sessionLog.log(`Registered: connectionId=${connectionId}`);
    sessionLog.log(`wsUrl: ${wsUrl}`);

    if (debugMode) {
      console.log(`[${formatTimestamp()}] Registered successfully`);
      console.log(`[${formatTimestamp()}]   connectionId: ${connectionId}`);
      console.log(`[${formatTimestamp()}]   wsUrl: ${wsUrl}`);
      console.log(`[${formatTimestamp()}] Connecting WebSocket...`);
      console.log("");
    }

    // Import and start WebSocket client
    const { startListenerClient } = await import(
      "../../websocket/listen-client"
    );

    // WS event logger: always writes to file, console only in --debug
    const wsEventLogger = (
      direction: "send" | "recv",
      label: "client" | "protocol" | "control" | "lifecycle",
      event: unknown,
    ): void => {
      sessionLog.wsEvent(direction, label, event);
      if (debugMode) {
        const arrow = direction === "send" ? "\u2192 send" : "\u2190 recv";
        const tag = label === "client" ? "" : ` (${label})`;
        const json = JSON.stringify(event);
        console.log(`[${formatTimestamp()}] ${arrow}${tag}  ${json}`);
      }
    };

    if (debugMode) {
      // Debug mode: plain-text event logging, no Ink UI
      await startListenerClient({
        connectionId,
        wsUrl,
        deviceId,
        connectionName,
        onWsEvent: wsEventLogger,
        onStatusChange: (status) => {
          sessionLog.log(`status: ${status}`);
          console.log(`[${formatTimestamp()}] status: ${status}`);
        },
        onConnected: () => {
          sessionLog.log("Connected. Awaiting instructions.");
          console.log(
            `[${formatTimestamp()}] Connected. Awaiting instructions.`,
          );
          console.log("");
        },
        onRetrying: (attempt, _maxAttempts, nextRetryIn) => {
          sessionLog.log(
            `Reconnecting (attempt ${attempt}, retry in ${Math.round(nextRetryIn / 1000)}s)`,
          );
          console.log(
            `[${formatTimestamp()}] Reconnecting (attempt ${attempt}, retry in ${Math.round(nextRetryIn / 1000)}s)`,
          );
        },
        onDisconnected: () => {
          sessionLog.log("Disconnected.");
          console.log(`[${formatTimestamp()}] Disconnected.`);
          process.exit(1);
        },
        onError: (error: Error) => {
          sessionLog.log(`Error: ${error.message}`);
          console.error(`[${formatTimestamp()}] Error: ${error.message}`);
          process.exit(1);
        },
      });
    } else {
      // Normal mode: interactive Ink UI
      console.clear();

      let updateStatusCallback:
        | ((status: "idle" | "receiving" | "processing") => void)
        | null = null;
      let updateRetryStatusCallback:
        | ((attempt: number, nextRetryIn: number) => void)
        | null = null;
      let clearRetryStatusCallback: (() => void) | null = null;

      const { unmount } = render(
        <ListenerStatusUI
          connectionId={connectionId}
          envName={connectionName}
          onReady={(callbacks) => {
            updateStatusCallback = callbacks.updateStatus;
            updateRetryStatusCallback = callbacks.updateRetryStatus;
            clearRetryStatusCallback = callbacks.clearRetryStatus;
          }}
        />,
      );

      await startListenerClient({
        connectionId,
        wsUrl,
        deviceId,
        connectionName,
        onWsEvent: wsEventLogger,
        onStatusChange: (status) => {
          sessionLog.log(`status: ${status}`);
          clearRetryStatusCallback?.();
          updateStatusCallback?.(status);
        },
        onConnected: () => {
          sessionLog.log("Connected. Awaiting instructions.");
          clearRetryStatusCallback?.();
          updateStatusCallback?.("idle");
        },
        onRetrying: (attempt, _maxAttempts, nextRetryIn) => {
          sessionLog.log(
            `Reconnecting (attempt ${attempt}, retry in ${Math.round(nextRetryIn / 1000)}s)`,
          );
          updateRetryStatusCallback?.(attempt, nextRetryIn);
        },
        onDisconnected: () => {
          sessionLog.log("Disconnected.");
          unmount();
          console.log("\n\u2717 Listener disconnected");
          console.log("Connection to Letta Cloud was lost.\n");
          process.exit(1);
        },
        onError: (error: Error) => {
          sessionLog.log(`Error: ${error.message}`);
          unmount();
          console.error(`\n\u2717 Listener error: ${error.message}\n`);
          process.exit(1);
        },
      });
    }

    // Keep process alive
    return new Promise<number>(() => {
      // Never resolves - runs until Ctrl+C
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sessionLog.log(`FATAL: ${msg}`);
    console.error(`Failed to start listener: ${msg}`);
    return 1;
  }
}
