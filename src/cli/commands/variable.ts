/**
 * /variable command handler for managing variables.
 * Variables are stored per agent and can be referenced via $SECRET_NAME syntax
 * in shell commands.
 */

import {
  deleteVariableOnServer,
  refreshAndListVariables,
  setVariableOnServer,
} from "@/utils/variables-store";

export interface VariableCommandResult {
  output: string;
}

/**
 * Handle the /variable command.
 * Usage:
 *   /variable set KEY value  - Set a variable
 *   /variable list           - List available variable names
 *   /variable unset KEY      - Unset a variable
 */
export async function handleVariableCommand(
  args: string[],
): Promise<VariableCommandResult> {
  const [subcommand, key, value] = args;

  switch (subcommand) {
    case "set": {
      if (!key) {
        return { output: "Usage: /variable set KEY value" };
      }
      if (!value) {
        return {
          output:
            "Usage: /variable set KEY value\nProvide a value for the variable.",
        };
      }

      const normalizedKey = key.toUpperCase();

      // Validate key format (must be valid for $SECRET_NAME pattern)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedKey)) {
        return {
          output: `Invalid variable name '${key}'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.`,
        };
      }

      try {
        await setVariableOnServer(normalizedKey, value);
        return {
          output: `Variable '$${normalizedKey}' set.`,
        };
      } catch (error) {
        return {
          output: `Failed to set variable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case "list": {
      let entries: Array<{ key: string; value: string }>;
      let names: string[];
      try {
        entries = await refreshAndListVariables();
        names = entries.map((variable) => variable.key);
      } catch (error) {
        return {
          output: `Failed to list variables: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (names.length === 0) {
        return {
          output:
            "No variables stored.\nUse /variable set KEY value to add a variable.",
        };
      }

      const lines = entries.map(
        ({ key, value }) => `  $${key} = ${JSON.stringify(value)}`,
      );
      return {
        output: `Available variables (${names.length}):\n${lines.join("\n")}\n\nUse $SECRET_NAME in shell commands to reference them.`,
      };
    }

    case "unset":
    case "delete":
    case "remove":
    case "rm": {
      if (!key) {
        return { output: "Usage: /variable unset KEY" };
      }

      const normalizedKey = key.toUpperCase();

      try {
        const deleted = await deleteVariableOnServer(normalizedKey);

        if (deleted) {
          return {
            output: `Variable '$${normalizedKey}' unset.`,
          };
        }

        return {
          output: `Variable '$${normalizedKey}' not found.\nUse /variable list to see available variables.`,
        };
      } catch (error) {
        return {
          output: `Failed to unset variable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case undefined:
    case "":
    case "help": {
      return {
        output: `Variable management commands:

  /variable set KEY value   Set a variable (KEY is normalized to uppercase)
  /variable list            List available variable names
  /variable unset KEY       Unset a variable

Variables are plain values stored per agent. Use $NAME in shell commands to load them into the environment. Their values are readable by the agent and are never redacted. Use secrets for passwords and credentials.`,
      };
    }

    default: {
      return {
        output: `Unknown subcommand '${subcommand}'.\nUse /variable help for usage.`,
      };
    }
  }
}
