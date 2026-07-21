import { runAppServerSubcommand } from "@/cli/subcommands/app-server";
import { runListenSubcommand } from "@/cli/subcommands/listen.tsx";

type ServerCommand =
  | { kind: "remote"; argv: string[] }
  | { kind: "app-server"; argv: string[] };

function printServerHelp(): void {
  console.log(`Usage:
  letta server [remote options]
  letta server --listen [url] [App Server options]

Run the local agent server as a remote environment, with messaging channels, or as an App Server.

Remote environment options:
  --env-name <name>  Friendly name for this environment (uses hostname if not provided)
  --channels <list>  Comma-separated channel names to enable (e.g. telegram)
  --install-channel-runtimes  Install missing runtime dependencies for selected channels
  --debug  Log WebSocket events instead of showing the interactive status UI

App Server options:
  --listen [url]  Accept App Server connections. If URL is omitted, binds to an available loopback port
  --ws-auth <mode>  Authentication for non-loopback listeners: capability-token or signed-bearer-token
  --ws-token-file <path>  Absolute path to the capability-token file
  --ws-token-sha256 <hex>  Hex-encoded SHA-256 digest of the capability token
  --ws-shared-secret-file <path>  Absolute path to the shared secret file for signed JWT bearer tokens
  --ws-issuer <issuer>  Expected issuer for signed JWT bearer tokens
  --ws-audience <audience>  Expected audience for signed JWT bearer tokens
  --ws-max-clock-skew-seconds <seconds>  Maximum signed-token clock skew

Common options:
  -h, --help  Show this help message

Examples:
  letta server
  letta server --env-name "work-laptop"
  letta server --channels telegram
  letta server --listen
  letta server --listen ws://127.0.0.1:4500
  letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token`);
}

function isListenOption(arg: string): boolean {
  return arg === "--listen" || arg.startsWith("--listen=");
}

export function resolveServerCommand(argv: string[]): ServerCommand {
  const appServerArgv: string[] = [];
  let foundListen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;

    if (!isListenOption(arg)) {
      appServerArgv.push(arg);
      continue;
    }

    if (foundListen) {
      throw new Error("--listen may only be specified once");
    }
    foundListen = true;

    if (arg.startsWith("--listen=")) {
      const listenUrl = arg.slice("--listen=".length);
      if (!listenUrl) {
        throw new Error(
          "--listen= requires a URL; use bare --listen for an available loopback port",
        );
      }
      appServerArgv.push("--listen", listenUrl);
      continue;
    }

    const possibleUrl = argv[index + 1];
    if (possibleUrl && !possibleUrl.startsWith("-")) {
      appServerArgv.push("--listen", possibleUrl);
      index += 1;
    }
  }

  if (foundListen) {
    const conflictingOption = argv.find(
      (arg) =>
        arg === "--env-name" ||
        arg.startsWith("--env-name=") ||
        arg === "--channels" ||
        arg.startsWith("--channels="),
    );
    if (conflictingOption) {
      throw new Error(
        `${conflictingOption.split("=")[0]} cannot be used with --listen`,
      );
    }
    return { kind: "app-server", argv: appServerArgv };
  }

  return { kind: "remote", argv };
}

export function asLegacyAppServerCommand(argv: string[]): string[] {
  return argv.some(isListenOption) ? argv : ["--listen", ...argv];
}

export async function runServerSubcommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printServerHelp();
    return 0;
  }

  let command: ServerCommand;
  try {
    command = resolveServerCommand(argv);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }

  if (command.kind === "app-server") {
    return runAppServerSubcommand(command.argv);
  }

  return runListenSubcommand(command.argv);
}
