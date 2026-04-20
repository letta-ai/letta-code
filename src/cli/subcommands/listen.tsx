/**
 * CLI subcommand: letta server --name \"george\"
 * Register letta-code as a listener to receive messages from Letta Cloud
 */

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { Box, render, Text } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import {
  LETTA_CLOUD_API_URL,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
} from "../../auth/oauth";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { RemoteSessionLog } from "../../websocket/listen-log";
import {
  type RegisterOptions,
  registerWithCloud,
  registerWithCloudRetry,
} from "../../websocket/listen-register";
import { ListenerStatusUI } from "../components/ListenerStatusUI";

const LISTENER_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

class MissingListenerApiKeyError extends Error {
  constructor() {
    super("LETTA_API_KEY not found");
    this.name = "MissingListenerApiKeyError";
  }
}

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

async function flushListenerTelemetryEnd(exitReason: string): Promise<void> {
  try {
    telemetry.trackSessionEnd(undefined, exitReason);
    await telemetry.flush();
  } catch {
    // Best-effort only.
  }
}

function getListenerServerUrl(settings: {
  env?: Record<string, string>;
}): string {
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  );
}

async function refreshListenerAccessToken(
  settings: Awaited<
    ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
  >,
  deviceId: string,
  connectionName: string,
): Promise<string> {
  const now = Date.now();

  console.log("Access token expired, refreshing...");

  const tokens = await refreshAccessToken(
    settings.refreshToken as string,
    deviceId,
    connectionName,
  );

  settingsManager.updateSettings({
    env: {
      ...settings.env,
      LETTA_API_KEY: tokens.access_token,
    },
    tokenExpiresAt: now + tokens.expires_in * 1000,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
  });
  await settingsManager.flush();

  console.log("Token refreshed successfully.");

  return tokens.access_token;
}

async function runListenerOAuthLogin(
  currentEnv: Record<string, string> | undefined,
  deviceId: string,
  connectionName: string,
): Promise<string> {
  console.log("No API key found. Starting OAuth login...\n");

  const deviceData = await requestDeviceCode();

  console.log(
    `To authenticate, visit: ${deviceData.verification_uri_complete}`,
  );
  console.log(`Your code: ${deviceData.user_code}\n`);
  console.log("Waiting for authorization...\n");

  const tokens = await pollForToken(
    deviceData.device_code,
    deviceData.interval,
    deviceData.expires_in,
    deviceId,
    connectionName,
  );
  const now = Date.now();

  settingsManager.updateSettings({
    env: {
      ...currentEnv,
      LETTA_API_KEY: tokens.access_token,
    },
    tokenExpiresAt: now + tokens.expires_in * 1000,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
  });
  await settingsManager.flush();

  console.log("Authenticated successfully.\n");

  return tokens.access_token;
}

async function resolveListenerRegistrationOptions(
  deviceId: string,
  connectionName: string,
): Promise<RegisterOptions> {
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const serverUrl = getListenerServerUrl(settings);
  const envApiKey = process.env.LETTA_API_KEY;

  if (envApiKey) {
    return {
      serverUrl,
      apiKey: envApiKey,
      deviceId,
      connectionName,
    };
  }

  let apiKey = settings.env?.LETTA_API_KEY;

  if (serverUrl === LETTA_CLOUD_API_URL) {
    const expiresAt = settings.tokenExpiresAt;
    if (settings.refreshToken && expiresAt) {
      const now = Date.now();
      if (!apiKey || now >= expiresAt - LISTENER_TOKEN_REFRESH_WINDOW_MS) {
        try {
          apiKey = await refreshListenerAccessToken(
            settings,
            deviceId,
            connectionName,
          );
        } catch (refreshErr) {
          console.warn(
            "Token refresh failed:",
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr),
          );
          apiKey = undefined;
        }
      }
    }

    if (!apiKey) {
      apiKey = await runListenerOAuthLogin(
        settings.env,
        deviceId,
        connectionName,
      );
    }
  }

  if (!apiKey) {
    throw new MissingListenerApiKeyError();
  }

  return {
    serverUrl,
    apiKey,
    deviceId,
    connectionName,
  };
}

export const __listenSubcommandTestUtils = {
  flushListenerTelemetryEnd,
  getListenerServerUrl,
  resolveListenerRegistrationOptions,
};

export async function runListenSubcommand(argv: string[]): Promise<number> {
  // Parse arguments
  const { values } = parseArgs({
    args: argv,
    options: {
      "env-name": { type: "string" },
      channels: { type: "string" },
      "install-channel-runtimes": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      debug: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const debugMode = !!values.debug;

  // Show help
  if (values.help) {
    console.log(
      "Usage: letta server [--env-name <name>] [--channels <list>] [--debug]\n",
    );
    console.log(
      "Register this letta-code instance to receive messages from Letta Cloud.\n",
    );
    console.log("Options:");
    console.log(
      "  --env-name <name>  Friendly name for this environment (uses hostname if not provided)",
    );
    console.log(
      "  --channels <list>  Comma-separated channel names to enable (e.g. telegram)",
    );
    console.log(
      "  --install-channel-runtimes  Install missing runtime deps for the selected channels before startup",
    );
    console.log(
      "  --debug            Plain-text mode: log all WebSocket events instead of interactive UI",
    );
    console.log("  -h, --help         Show this help message\n");
    console.log("Examples:");
    console.log(
      "  letta channels configure telegram          # Configure Telegram first",
    );
    console.log(
      "  letta server                              # Uses hostname as default",
    );
    console.log('  letta server --env-name "work-laptop"');
    console.log(
      "  letta server --channels telegram           # Enable Telegram channel",
    );
    console.log(
      "  letta server --channels telegram --install-channel-runtimes",
    );
    console.log(
      "  letta server --debug                       # Log all WS events\n",
    );
    console.log(
      "Once connected, this instance will listen for incoming messages from cloud agents.",
    );
    console.log(
      "Messages will be executed locally using your letta-code environment.",
    );
    console.log(
      "Telegram flow: configure the bot, start the listener with --channels telegram,",
    );
    console.log(
      "then message the bot from Telegram and run /channels telegram pair <code> in the target conversation.",
    );
    return 0;
  }

  await settingsManager.initialize();
  telemetry.setSurface("websocket");
  telemetry.init();

  const exitWithTelemetry = async (
    code: number,
    exitReason: string,
  ): Promise<never> => {
    // Stop channel adapters on actual process exit
    try {
      const { getChannelRegistry } = await import("../../channels/registry");
      const registry = getChannelRegistry();
      if (registry) {
        await registry.stopAll();
      }
    } catch {
      // Best effort — don't block exit on channel cleanup failure
    }
    await flushListenerTelemetryEnd(exitReason);
    process.exit(code);
  };

  // Load local project settings to access saved environment name
  await settingsManager.loadLocalProjectSettings();

  // Initialize channels if explicitly requested, or restore persisted enabled
  // channels when a desktop wrapper opts into boot-time channel restore.
  const channelNames = values.channels
    ? values.channels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : process.env.LETTA_RESTORE_ENABLED_CHANNELS === "1"
      ? (await import("../../channels/service")).listEnabledChannelIds()
      : [];

  if (channelNames.length > 0) {
    if (values.channels && values["install-channel-runtimes"]) {
      const { ensureChannelRuntimeInstalled } = await import(
        "../../channels/runtimeDeps"
      );
      const { isSupportedChannelId } = await import(
        "../../channels/pluginRegistry"
      );

      for (const channelName of channelNames) {
        if (!isSupportedChannelId(channelName)) {
          console.error(
            `Unknown channel "${channelName}" passed to --channels.`,
          );
          return 1;
        }
        await ensureChannelRuntimeInstalled(channelName);
      }
    }

    const { initializeChannels } = await import("../../channels/registry");
    await initializeChannels(channelNames);
  }

  // Determine connection name
  let connectionName: string;

  if (values["env-name"]) {
    // Explicitly provided - use it and save to local project settings
    connectionName = values["env-name"];
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
    let registerOptions: RegisterOptions;

    try {
      registerOptions = await resolveListenerRegistrationOptions(
        deviceId,
        connectionName,
      );
    } catch (authErr) {
      if (authErr instanceof MissingListenerApiKeyError) {
        console.error("Error: LETTA_API_KEY not found");
        console.error("Set your API key with: export LETTA_API_KEY=<your-key>");
        await flushListenerTelemetryEnd("listener_missing_api_key");
        return 1;
      }

      console.error(
        "OAuth login failed:",
        authErr instanceof Error ? authErr.message : String(authErr),
      );
      await flushListenerTelemetryEnd("listener_oauth_failed");
      return 1;
    }

    sessionLog.log(`Session started (debug=${debugMode})`);
    sessionLog.log(`deviceId: ${deviceId}`);
    sessionLog.log(`connectionName: ${connectionName}`);

    if (debugMode) {
      console.log(
        `[${formatTimestamp()}] Registering with ${registerOptions.serverUrl}/v1/environments/register`,
      );
      console.log(`[${formatTimestamp()}]   deviceId: ${deviceId}`);
      console.log(`[${formatTimestamp()}]   connectionName: ${connectionName}`);
    }
    sessionLog.log(
      `Registering with ${registerOptions.serverUrl}/v1/environments/register`,
    );

    const { connectionId, wsUrl } = await registerWithCloud(registerOptions);

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

    // Re-register helper with retry for transient errors (e.g. 521).
    // Uses exponential backoff so a temporary server outage doesn't
    // permanently kill the connection.
    const reregister = async (): Promise<{
      connectionId: string;
      wsUrl: string;
    }> => {
      sessionLog.log("Re-registering with retry...");
      const nextRegisterOptions = await resolveListenerRegistrationOptions(
        deviceId,
        connectionName,
      );
      const result = await registerWithCloudRetry(nextRegisterOptions, {
        onRetry: (attempt, delayMs, error) => {
          sessionLog.log(
            `Registration retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
          );
          if (debugMode) {
            console.log(
              `[${formatTimestamp()}] Registration retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
            );
          }
        },
      });
      sessionLog.log(`Re-registered: connectionId=${result.connectionId}`);
      return result;
    };

    const shouldLogWsEvents =
      debugMode || process.env.LETTA_LOG_WS_EVENTS === "1";

    // WS event logger: optionally writes to file, console only in --debug
    const wsEventLogger = (
      direction: "send" | "recv",
      label: "client" | "protocol" | "control" | "lifecycle",
      event: unknown,
    ): void => {
      if (!shouldLogWsEvents) {
        return;
      }
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
      const startDebugClient = async (
        connId: string,
        url: string,
      ): Promise<void> => {
        await startListenerClient({
          connectionId: connId,
          wsUrl: url,
          deviceId,
          connectionName,
          onWsEvent: shouldLogWsEvents ? wsEventLogger : undefined,
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
          onNeedsReregister: async () => {
            console.log(
              `[${formatTimestamp()}] Environment expired, re-registering...`,
            );
            try {
              const result = await reregister();
              await startDebugClient(result.connectionId, result.wsUrl);
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              sessionLog.log(`Re-registration failed: ${msg}`);
              console.error(
                `[${formatTimestamp()}] Re-registration failed: ${msg}`,
              );
              await exitWithTelemetry(1, "listener_reregister_failed");
            }
          },
          onDisconnected: () => {
            sessionLog.log("Disconnected.");
            console.log(`[${formatTimestamp()}] Disconnected.`);
            void exitWithTelemetry(1, "listener_disconnected");
          },
          onError: (error: Error) => {
            sessionLog.log(`Error: ${error.message}`);
            console.error(`[${formatTimestamp()}] Error: ${error.message}`);
            void exitWithTelemetry(1, "listener_error");
          },
        });
      };
      await startDebugClient(connectionId, wsUrl);
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

      const startNormalClient = async (
        connId: string,
        url: string,
      ): Promise<void> => {
        await startListenerClient({
          connectionId: connId,
          wsUrl: url,
          deviceId,
          connectionName,
          onWsEvent: shouldLogWsEvents ? wsEventLogger : undefined,
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
          onNeedsReregister: async () => {
            sessionLog.log("Environment expired, re-registering...");
            try {
              const result = await reregister();
              await startNormalClient(result.connectionId, result.wsUrl);
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              sessionLog.log(`Re-registration failed: ${msg}`);
              unmount();
              console.error(`\n\u2717 Re-registration failed: ${msg}\n`);
              await exitWithTelemetry(1, "listener_reregister_failed");
            }
          },
          onDisconnected: () => {
            sessionLog.log("Disconnected.");
            unmount();
            console.log("\n\u2717 Listener disconnected");
            console.log("Connection to Letta Cloud was lost.\n");
            void exitWithTelemetry(1, "listener_disconnected");
          },
          onError: (error: Error) => {
            sessionLog.log(`Error: ${error.message}`);
            unmount();
            console.error(`\n\u2717 Listener error: ${error.message}\n`);
            void exitWithTelemetry(1, "listener_error");
          },
        });
      };
      await startNormalClient(connectionId, wsUrl);
    }

    // Keep process alive
    return new Promise<number>(() => {
      // Never resolves - runs until Ctrl+C
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sessionLog.log(`FATAL: ${msg}`);
    console.error(`Failed to start listener: ${msg}`);
    await flushListenerTelemetryEnd("listener_start_failed");
    return 1;
  }
}
