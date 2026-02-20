/**
 * CLI subcommand: letta listen --name "george"
 * Register letta-code as a listener to receive messages from Letta Cloud
 */

import { parseArgs } from "node:util";
import { render } from "ink";
import { getServerUrl } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import { ListenerStatusUI } from "../components/ListenerStatusUI";

export async function runListenSubcommand(argv: string[]): Promise<number> {
  // Preprocess args to support --conv as alias for --conversation
  const processedArgv = argv.map((arg) =>
    arg === "--conv" ? "--conversation" : arg,
  );

  // Parse arguments
  const { values } = parseArgs({
    args: processedArgv,
    options: {
      name: { type: "string" },
      agent: { type: "string" },
      conversation: { type: "string", short: "C" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  // Show help
  if (values.help) {
    console.log(
      "Usage: letta listen --name <connection-name> [--agent <agent-id>] [--conversation <id>]\n",
    );
    console.log(
      "Register this letta-code instance to receive messages from Letta Cloud.\n",
    );
    console.log("Options:");
    console.log(
      "  --name <name>      Friendly name for this connection (required)",
    );
    console.log(
      "  --agent <id>       Bind connection to specific agent (required for CLI usage)",
    );
    console.log("  --conversation <id>, --conv <id>, -C <id>");
    console.log(
      "                     Route messages to a specific conversation",
    );
    console.log("  -h, --help         Show this help message\n");
    console.log("Examples:");
    console.log('  letta listen --name "george" --agent agent-abc123');
    console.log('  letta listen --name "laptop-work" --agent agent-xyz789');
    console.log(
      '  letta listen --name "daily-cron" --agent agent-abc123 --conv conv-xyz789\n',
    );
    console.log(
      "Once connected, this instance will listen for incoming messages from cloud agents.",
    );
    console.log(
      "Messages will be executed locally using your letta-code environment.",
    );
    return 0;
  }

  const connectionName = values.name;
  const agentId = values.agent;
  const conversationId = values.conversation as string | undefined;

  if (!connectionName) {
    console.error("Error: --name is required\n");
    console.error('Usage: letta listen --name "george" --agent agent-abc123\n');
    console.error(
      "Provide a friendly name to identify this connection (e.g., your name, device name).",
    );
    return 1;
  }

  if (!agentId) {
    console.error("Error: --agent is required\n");
    console.error('Usage: letta listen --name "george" --agent agent-abc123\n');
    console.error(
      "A listener connection needs a default agent to execute messages.",
    );
    console.error(
      "Specify which agent should receive messages from this connection.",
    );
    return 1;
  }

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
        agentId,
        ...(conversationId && { conversationId }),
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
        agentId={agentId}
        connectionId={connectionId}
        conversationId={conversationId}
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
      agentId,
      defaultConversationId: conversationId,
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
