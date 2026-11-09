import { parseArgs } from "node:util";
import {
  type AppServerListeningInfo,
  startAppServer,
} from "@/websocket/app-server";
import {
  type AppServerWebsocketAuthSettings,
  parseAppServerWebsocketAuthSettings,
} from "@/websocket/app-server-auth";

function printAppServerHelp(): void {
  console.log(
    `Usage: letta server --listen [url]

Run the local App Server using native v2 WebSocket frames.

Options:
  --listen [url]  WebSocket listen URL. Defaults to an available loopback port
  --openai-api  Serve OpenAI-compatible /v1/models, /v1/chat/completions, and /v1/responses routes (each agent is a model)
  --ws-auth <mode>  WebSocket auth for non-loopback listeners and Origin-bearing native clients. Supported: capability-token, signed-bearer-token
  --ws-token-file <path>  Absolute path to the capability-token file
  --ws-token-sha256 <hex>  Hex-encoded SHA-256 digest of the capability token
  --ws-shared-secret-file <path>  Absolute path to the shared secret file for signed JWT bearer tokens
  --ws-issuer <issuer>  Expected issuer for signed JWT bearer tokens
  --ws-audience <audience>  Expected audience for signed JWT bearer tokens
  --ws-max-clock-skew-seconds <seconds>  Maximum clock skew for signed JWT bearer token validation
  -h, --help      Show this help message

Examples:
  letta server --listen
  letta server --listen ws://127.0.0.1:4500
  letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token
  letta server --listen ws://0.0.0.0:4500 --ws-auth signed-bearer-token --ws-shared-secret-file /path/to/secret
  letta server --listen ws://127.0.0.1:4500 --openai-api`,
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
          console.log(`\nStopped App Server (${signal}).`);
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

/** App Server settings parsed from `letta server --listen` arguments. */
export interface AppServerCliOptions {
  listen?: string;
  websocketAuth: AppServerWebsocketAuthSettings;
  openaiApi: boolean;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse App Server arguments; throws on unknown or invalid options. */
export function parseAppServerCliArgs(
  argv: string[],
): { help: true } | ({ help: false } & AppServerCliOptions) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      listen: { type: "string" },
      "openai-api": { type: "boolean" },
      "ws-auth": { type: "string" },
      "ws-token-file": { type: "string" },
      "ws-token-sha256": { type: "string" },
      "ws-shared-secret-file": { type: "string" },
      "ws-issuer": { type: "string" },
      "ws-audience": { type: "string" },
      "ws-max-clock-skew-seconds": { type: "string" },
    },
  });
  if (values.help) return { help: true };
  return {
    help: false,
    listen: stringOption(values.listen),
    openaiApi: values["openai-api"] === true,
    websocketAuth: parseAppServerWebsocketAuthSettings({
      wsAuth: stringOption(values["ws-auth"]),
      wsTokenFile: stringOption(values["ws-token-file"]),
      wsTokenSha256: stringOption(values["ws-token-sha256"]),
      wsSharedSecretFile: stringOption(values["ws-shared-secret-file"]),
      wsIssuer: stringOption(values["ws-issuer"]),
      wsAudience: stringOption(values["ws-audience"]),
      wsMaxClockSkewSeconds: stringOption(values["ws-max-clock-skew-seconds"]),
    }),
  };
}

/** Print the App Server's addresses in the format SDK launchers parse. */
export function printAppServerListening(
  info: AppServerListeningInfo,
  openaiApi: boolean,
): void {
  console.log(`Listening on ${info.url}`);
  console.log(`WebSocket: ${info.controlUrl}`);
  if (openaiApi) {
    const openaiBase = new URL(info.url);
    openaiBase.protocol = "http:";
    console.log(`OpenAI:  ${openaiBase.origin}/v1`);
  }
}

export async function runAppServerSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseAppServerCliArgs>;
  try {
    parsed = parseAppServerCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }

  if (parsed.help) {
    printAppServerHelp();
    return 0;
  }

  try {
    const handle = await startAppServer({
      listen: parsed.listen,
      websocketAuth: parsed.websocketAuth,
      openaiApi: parsed.openaiApi,
      onListening: (info) => printAppServerListening(info, parsed.openaiApi),
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
