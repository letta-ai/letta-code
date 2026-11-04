import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { createAppServerClient } from "@/app-server-client";
import {
  type DirectComputer,
  formatDirectComputerSelector,
  isInsecureRemoteUrl,
  listDirectComputers,
  readDirectComputerToken,
  removeDirectComputer,
  saveDirectComputer,
} from "@/backend/direct-computers";

export const DIRECT_COMPUTER_ACTIONS = new Set([
  "add-direct",
  "remove-direct",
  "list-direct",
]);

export const DIRECT_COMPUTER_USAGE = `
Direct App Server computers (no Letta Cloud):
  letta computers add-direct <name> <ws-url> --token-file <path>
  letta computers remove-direct <name>
  letta computers list-direct [--check]

  Run \`letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token
  --ws-token-file <path>\` on the remote machine, copy the same token file
  here, then use Agent(harness=..., computer="direct:<name>"). Direct
  computers run external coding workers only.`;

export interface DirectComputersDeps {
  env?: NodeJS.ProcessEnv;
  probe?: (computer: DirectComputer) => Promise<string>;
}

/** Connect and ask the App Server for its version. */
async function defaultProbe(computer: DirectComputer): Promise<string> {
  const token = readDirectComputerToken(computer);
  const client = createAppServerClient({
    url: computer.url,
    authToken: token,
    WebSocket,
    requestTimeoutMs: 10_000,
  });
  try {
    await client.connect();
    const info = await client.info();
    return info.letta_code_version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(token).join("[redacted]"));
  } finally {
    client.close();
  }
}

function parseDirectArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      "token-file": { type: "string" },
      check: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export async function runDirectComputersAction(
  argv: string[],
  deps: DirectComputersDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let parsed: ReturnType<typeof parseDirectArgs>;
  try {
    parsed = parseDirectArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const [action, name, url] = parsed.positionals;
  try {
    if (action === "add-direct") {
      const tokenFile = parsed.values["token-file"];
      if (!name || !url || !tokenFile) {
        console.error(
          "Usage: letta computers add-direct <name> <ws-url> --token-file <path>",
        );
        return 1;
      }
      const computer = {
        name,
        url,
        tokenFile: isAbsolute(tokenFile) ? tokenFile : resolve(tokenFile),
      };
      readDirectComputerToken(computer);
      saveDirectComputer(computer, env);
      if (isInsecureRemoteUrl(url))
        console.error(
          "Warning: ws:// sends the token and all task traffic unencrypted. Prefer wss:// or a private network.",
        );
      console.log(
        JSON.stringify(
          { ...computer, selector: formatDirectComputerSelector(name) },
          null,
          2,
        ),
      );
      return 0;
    }
    if (action === "remove-direct") {
      if (!name) {
        console.error("Usage: letta computers remove-direct <name>");
        return 1;
      }
      if (!removeDirectComputer(name, env)) {
        console.error(`Direct computer "${name}" is not configured.`);
        return 1;
      }
      return 0;
    }
    if (action === "list-direct") {
      const probe = deps.probe ?? defaultProbe;
      const computers = await Promise.all(
        listDirectComputers(env).map(async (computer) => {
          const row = {
            ...computer,
            selector: formatDirectComputerSelector(computer.name),
          };
          if (!parsed.values.check) return row;
          try {
            return {
              ...row,
              isOnline: true,
              lettaCodeVersion: await probe(computer),
            };
          } catch (error) {
            return {
              ...row,
              isOnline: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      console.log(JSON.stringify({ computers }, null, 2));
      return 0;
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  console.error(`Unknown action: ${action}`);
  return 1;
}
