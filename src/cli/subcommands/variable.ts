/** `letta variable` manages plain, agent-readable values. */

import { parseArgs } from "node:util";
import { settingsManager } from "@/settings-manager";
import { readStdin } from "@/utils/stdin";
import {
  deleteVariableOnServer,
  refreshAndListVariables,
  setVariableOnServer,
} from "@/utils/variables-store";

export interface VariableSubcommandDeps {
  deleteVariable?: typeof deleteVariableOnServer;
  initializeSettings?: () => Promise<void>;
  listVariables?: typeof refreshAndListVariables;
  readStdin?: () => Promise<string>;
  setVariable?: typeof setVariableOnServer;
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
  letta variable set KEY --env SOURCE_VAR   Set KEY from environment variable SOURCE_VAR
  letta variable set KEY --stdin            Set KEY from piped stdin
  letta variable set KEY VALUE              Set KEY directly (exposes the value in argv)
  letta variable list                       List variable names and values
  letta variable unset KEY                  Unset a variable (aliases: delete | remove | rm)

Options:
  --agent <agent-id>   Target agent (defaults to LETTA_AGENT_ID / AGENT_ID)
  --env <VAR>          Read the variable value from this environment variable
  --stdin              Read the variable value from stdin
  -h, --help           Show this help

Variables are plain values, visible to the agent and never redacted. Use secrets for passwords and credentials.
`.trim(),
  );
}

function parseVariableArgs(argv: string[]) {
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

export async function runVariableSubcommand(
  argv: string[],
  deps: VariableSubcommandDeps = {},
): Promise<number> {
  const listVariables = deps.listVariables ?? refreshAndListVariables;
  const setVariable = deps.setVariable ?? setVariableOnServer;
  const deleteVariable = deps.deleteVariable ?? deleteVariableOnServer;
  const readInput = deps.readStdin ?? readStdin;
  const initializeSettings =
    deps.initializeSettings ?? (async () => settingsManager.initialize());

  let parsed: ReturnType<typeof parseVariableArgs>;
  try {
    parsed = parseVariableArgs(argv);
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
        const variables = await listVariables(agentIdArg);
        const names = variables.map((variable) => variable.key).sort();
        if (names.length === 0) {
          console.log("No variables stored.");
          return 0;
        }
        console.log(`Available variables (${names.length}):`);
        for (const name of names) {
          console.log(
            `  $${name} = ${JSON.stringify(variables.find((entry) => entry.key === name)?.value)}`,
          );
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
          "Usage: letta variable set KEY [--env VAR | --stdin | VALUE]",
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
        const piped = (await readInput()).replace(/\r?\n$/, "");
        if (!piped) {
          console.error("No value received on stdin.");
          return 1;
        }
        value = piped;
      } else {
        if (rawValue === undefined) {
          console.error(
            "Usage: letta variable set KEY [--env VAR | --stdin | VALUE]",
          );
          return 1;
        }
        value = rawValue;
      }

      const key = normalizeKey(rawKey);
      try {
        await setVariable(key, value, agentIdArg);
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
      console.log(`Variable '$${key}' set.`);
      return 0;
    }

    case "unset":
    case "delete":
    case "remove":
    case "rm": {
      if (!rawKey) {
        console.error("Usage: letta variable unset KEY");
        return 1;
      }
      const key = normalizeKey(rawKey);
      let deleted: boolean;
      try {
        deleted = await deleteVariable(key, agentIdArg);
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
        console.error(`Variable '$${key}' not found.`);
        return 1;
      }
      console.log(`Variable '$${key}' unset.`);
      return 0;
    }

    default: {
      console.error(`Unknown subcommand '${verb ?? ""}'.`);
      printUsage();
      return 1;
    }
  }
}
