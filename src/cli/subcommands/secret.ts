/**
 * `letta secret` subcommand for managing agent-scoped secrets.
 * Values are ingested through the environment (--env) or stdin so agents can
 * persist credentials without the value appearing in shell history, process
 * listings, or agent context.
 */

import { parseArgs } from "node:util";
import { settingsManager } from "@/settings-manager";
import {
  deleteSecretOnServer,
  refreshAndListSecrets,
  setSecretOnServer,
} from "@/utils/secrets-store";

export interface SecretSubcommandDeps {
  deleteSecret?: typeof deleteSecretOnServer;
  initializeSettings?: () => Promise<void>;
  listSecrets?: typeof refreshAndListSecrets;
  readStdin?: () => Promise<string>;
  setSecret?: typeof setSecretOnServer;
}

const SECRET_OPTIONS = {
  agent: { type: "string" },
  env: { type: "string" },
  help: { type: "boolean", short: "h" },
  stdin: { type: "boolean" },
} as const;

function printUsage(): void {
  console.log(
    `
Usage:
  letta secret set KEY --env SOURCE_VAR   Set KEY from environment variable SOURCE_VAR
  letta secret set KEY --stdin            Set KEY from piped stdin
  letta secret set KEY VALUE              Set KEY directly (exposes the value in argv)
  letta secret list                       List secret names (never values)
  letta secret unset KEY                  Unset a secret (aliases: delete | remove | rm)

Options:
  --agent <agent-id>   Target agent (defaults to LETTA_AGENT_ID / AGENT_ID)
  --env <VAR>          Read the secret value from this environment variable
  --stdin              Read the secret value from stdin
  -h, --help           Show this help

Notes:
  - Prefer --env or --stdin so the value never appears in shell history,
    process listings, or agent context. For example:
      openssl rand -hex 32 | letta secret set WEBHOOK_TOKEN --stdin
  - Pass the variable name to --env (not $NAME). $NAME is substituted by the
    harness and would place the resolved value in process arguments.
  - A running session picks up CLI-side changes at its next session start.
`.trim(),
  );
}

function parseSecretArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SECRET_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function normalizeKey(key: string): string {
  return key.toUpperCase();
}

function printError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
}

async function readProcessStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function runSecretSubcommand(
  argv: string[],
  deps: SecretSubcommandDeps = {},
): Promise<number> {
  const listSecrets = deps.listSecrets ?? refreshAndListSecrets;
  const setSecret = deps.setSecret ?? setSecretOnServer;
  const deleteSecret = deps.deleteSecret ?? deleteSecretOnServer;
  const readStdin = deps.readStdin ?? readProcessStdin;
  const initializeSettings =
    deps.initializeSettings ?? (async () => settingsManager.initialize());

  let parsed: ReturnType<typeof parseSecretArgs>;
  try {
    parsed = parseSecretArgs(argv);
  } catch (error) {
    printError(error);
    printUsage();
    return 1;
  }

  if (parsed.values.help || parsed.positionals.length === 0) {
    printUsage();
    return parsed.values.help ? 0 : 1;
  }

  const [verb, rawKey, rawValue] = parsed.positionals;
  const agentIdArg = parsed.values.agent?.trim() || undefined;

  if (verb !== "help") {
    await initializeSettings();
  }

  switch (verb) {
    case "help": {
      printUsage();
      return 0;
    }

    case "list": {
      try {
        const secrets = await listSecrets(agentIdArg);
        const names = secrets.map((secret) => secret.key).sort();
        if (names.length === 0) {
          console.log("No secrets stored.");
          return 0;
        }
        console.log(`Available secrets (${names.length}):`);
        for (const name of names) {
          console.log(`  $${name}`);
        }
        return 0;
      } catch (error) {
        printError(error);
        if (
          error instanceof Error &&
          error.message.includes("No agent context")
        ) {
          console.error(
            "Specify --agent <agent-id>, or run inside a session where LETTA_AGENT_ID or AGENT_ID is set.",
          );
        }
        return 1;
      }
    }

    case "set": {
      if (!rawKey) {
        console.error(
          "Usage: letta secret set KEY [--env VAR | --stdin | VALUE]",
        );
        return 1;
      }

      const hasEnv = typeof parsed.values.env === "string";
      const hasStdin = Boolean(parsed.values.stdin);
      if (hasEnv && hasStdin) {
        console.error("Use either --env or --stdin, not both.");
        return 1;
      }

      let value: string;
      if (hasEnv) {
        if (rawValue !== undefined) {
          console.error(
            "Pass either a positional value or --env/--stdin, not both.",
          );
          return 1;
        }
        const source = parsed.values.env as string;
        const fromEnv = process.env[source];
        if (fromEnv === undefined || fromEnv === "") {
          console.error(`Environment variable '${source}' is not set.`);
          return 1;
        }
        value = fromEnv;
      } else if (hasStdin) {
        if (rawValue !== undefined) {
          console.error(
            "Pass either a positional value or --env/--stdin, not both.",
          );
          return 1;
        }
        const piped = (await readStdin()).replace(/\r?\n$/, "");
        if (!piped) {
          console.error("No value received on stdin.");
          return 1;
        }
        value = piped;
      } else {
        if (rawValue === undefined) {
          console.error(
            "Usage: letta secret set KEY [--env VAR | --stdin | VALUE]",
          );
          return 1;
        }
        value = rawValue;
        console.error(
          "Warning: the value was passed as an argument and may appear in shell history and process listings. Prefer --env or --stdin.",
        );
      }

      const key = normalizeKey(rawKey);
      try {
        await setSecret(key, value, agentIdArg);
      } catch (error) {
        printError(error);
        if (
          error instanceof Error &&
          error.message.includes("No agent context")
        ) {
          console.error(
            "Specify --agent <agent-id>, or run inside a session where LETTA_AGENT_ID or AGENT_ID is set.",
          );
        }
        return 1;
      }
      console.log(`Secret '$${key}' set.`);
      return 0;
    }

    case "unset":
    case "delete":
    case "remove":
    case "rm": {
      if (!rawKey) {
        console.error("Usage: letta secret unset KEY");
        return 1;
      }
      const key = normalizeKey(rawKey);
      let deleted: boolean;
      try {
        deleted = await deleteSecret(key, agentIdArg);
      } catch (error) {
        printError(error);
        if (
          error instanceof Error &&
          error.message.includes("No agent context")
        ) {
          console.error(
            "Specify --agent <agent-id>, or run inside a session where LETTA_AGENT_ID or AGENT_ID is set.",
          );
        }
        return 1;
      }
      if (!deleted) {
        console.error(`Secret '$${key}' not found.`);
        return 1;
      }
      console.log(`Secret '$${key}' unset.`);
      return 0;
    }

    default: {
      console.error(`Unknown subcommand '${verb ?? ""}'.`);
      printUsage();
      return 1;
    }
  }
}
