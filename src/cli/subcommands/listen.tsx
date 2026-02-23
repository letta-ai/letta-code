/**
 * CLI subcommand: letta listen --name "george"
 * Register letta-code as a listener to receive messages from Letta Cloud
 */

import { parseArgs } from "node:util";
import { render } from "ink";
import { getServerUrl } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import { ListenerStatusUI } from "../components/ListenerStatusUI";
import { uniqueNameGenerator } from "../commands/listen";

export async function runListenSubcommand(argv: string[]): Promise<number> {
  // Parse arguments
  const { values } = parseArgs({
    args: argv,
    options: {
      envName: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  // Show help
  if (values.help) {
    console.log("Usage: letta listen [--env-name <name>]\n");
    console.log(
      "Register this letta-code instance to receive messages from Letta Cloud.\n",
    );
    console.log("Options:");
    console.log(
      "  --env-name <name>  Friendly name for this environment (auto-generated if not provided)",
    );
    console.log("  -h, --help         Show this help message\n");
    console.log("Examples:");
    console.log("  letta listen");
    console.log('  letta listen --env-name "work-laptop"\n');
    console.log(
      "Once connected, this instance will listen for incoming messages from cloud agents.",
    );
    console.log(
      "Messages will be executed locally using your letta-code environment.",
    );
    return 0;
  }

  // Generate connection name if not provided
  const connectionName = values.envName || uniqueNameGenerator();

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

    // Register with cloud
    const serverUrl = getServerUrl();
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
      }),
    });

    if (!registerResponse.ok) {
      const error = (await registerResponse.json()) as { message?: string };
      console.error(`Registration failed: ${error.message || "Unknown error"}`);
      return 1;
    }

    const { connectionId, wsUrl } = (await registerResponse.json()) as {
      connectionId: string;
      wsUrl: string;
    };

    // Clear screen and render Ink UI
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

    // Import and start WebSocket client
    const { startListenerClient } = await import(
      "../../websocket/listen-client"
    );

    await startListenerClient({
      connectionId,
      wsUrl,
      deviceId,
      connectionName,
      onStatusChange: (status) => {
        clearRetryStatusCallback?.();
        updateStatusCallback?.(status);
      },
      onConnected: () => {
        clearRetryStatusCallback?.();
        updateStatusCallback?.("idle");
      },
      onRetrying: (attempt, _maxAttempts, nextRetryIn) => {
        updateRetryStatusCallback?.(attempt, nextRetryIn);
      },
      onDisconnected: () => {
        unmount();
        console.log("\n✗ Listener disconnected");
        console.log("Connection to Letta Cloud was lost.\n");
        process.exit(1);
      },
      onError: (error: Error) => {
        unmount();
        console.error(`\n✗ Listener error: ${error.message}\n`);
        process.exit(1);
      },
    });

    // Keep process alive
    return new Promise<number>(() => {
      // Never resolves - runs until Ctrl+C
    });
  } catch (error) {
    console.error(
      `Failed to start listener: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
