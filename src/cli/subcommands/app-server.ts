import { parseArgs } from "node:util";
import {
  APP_SERVER_AUTH_TOKEN_ENV,
  APP_SERVER_PUBLIC_URL_ENV,
  startAppServer,
} from "@/websocket/app-server";

function printAppServerHelp(): void {
  console.log(
    `Usage: letta app-server [--listen <url>] [--auth-token <token>] [--public-url <url>]

Run a local Letta Code app-server using native v2 websocket frames.

Options:
  --listen <url>      WebSocket listen URL. Defaults to ws://127.0.0.1:0
  --auth-token <tok>  Require this token for WebSocket upgrades
  --public-url <url>  Public ws:// or wss:// base URL to print for clients
  -h, --help          Show this help message

Environment:
  ${APP_SERVER_AUTH_TOKEN_ENV}  Default auth token
  ${APP_SERVER_PUBLIC_URL_ENV}  Default public URL

Examples:
  letta app-server
  letta app-server --listen ws://127.0.0.1:4500
  letta app-server --backend local --listen ws://0.0.0.0:$PORT --auth-token "$LETTA_APP_SERVER_AUTH_TOKEN" --public-url "wss://$RAILWAY_PUBLIC_DOMAIN"`,
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
        "auth-token": { type: "string" },
        "public-url": { type: "string" },
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
    const handle = await startAppServer({
      listen:
        typeof parsed.values.listen === "string"
          ? parsed.values.listen
          : undefined,
      authToken:
        typeof parsed.values["auth-token"] === "string"
          ? parsed.values["auth-token"]
          : undefined,
      publicUrl:
        typeof parsed.values["public-url"] === "string"
          ? parsed.values["public-url"]
          : undefined,
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
