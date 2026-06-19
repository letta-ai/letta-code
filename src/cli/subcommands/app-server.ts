import { parseArgs } from "node:util";
import { startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";

function printAppServerHelp(): void {
  console.log(
    `Usage: letta app-server [--listen <url>]

Run a local Letta Code app-server using native v2 websocket frames.

Options:
  --listen <url>  WebSocket listen URL. Defaults to ws://127.0.0.1:0
  --ws-auth <mode>  WebSocket auth mode for non-loopback listeners. Supported: capability-token
  --ws-token-file <path>  Absolute path to the capability-token file
  --ws-token-sha256 <hex>  Hex-encoded SHA-256 digest of the capability token
  -h, --help      Show this help message

Examples:
  letta app-server
  letta app-server --listen ws://127.0.0.1:4500
  letta app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token`,
  );
}

async function waitForShutdown(close: () => Promise<void>): Promise<number> {
  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void close()
        .then(() => {
          console.log(`\nStopped app-server (${signal}).`);
          resolve(0);
        })
        .catch((error) => {
          console.error(
            error instanceof Error ? `Error: ${error.message}` : String(error),
          );
          resolve(1);
        });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function runAppServerSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        listen: { type: "string" },
        "ws-auth": { type: "string" },
        "ws-token-file": { type: "string" },
        "ws-token-sha256": { type: "string" },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }

  if (parsed.values.help) {
    printAppServerHelp();
    return 0;
  }

  try {
    const websocketAuth = parseAppServerWebsocketAuthSettings({
      wsAuth:
        typeof parsed.values["ws-auth"] === "string"
          ? parsed.values["ws-auth"]
          : undefined,
      wsTokenFile:
        typeof parsed.values["ws-token-file"] === "string"
          ? parsed.values["ws-token-file"]
          : undefined,
      wsTokenSha256:
        typeof parsed.values["ws-token-sha256"] === "string"
          ? parsed.values["ws-token-sha256"]
          : undefined,
    });

    const handle = await startAppServer({
      listen:
        typeof parsed.values.listen === "string"
          ? parsed.values.listen
          : undefined,
      websocketAuth,
      onListening: (info) => {
        console.log(`Listening on ${info.url}`);
        console.log(`Control: ${info.controlUrl}`);
        console.log(`Stream:  ${info.streamUrl}`);
      },
      onLog: (message) => {
        console.error(message);
      },
    });

    return await waitForShutdown(handle.close);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }
}
