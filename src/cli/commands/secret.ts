/**
 * /secret command handler for managing secrets.
 * Secrets are stored on the Letta server and can be referenced
 * via $SECRET_NAME syntax in shell commands.
 */

import {
  deleteSecretOnServer,
  listSecretNames,
  setSecretOnServer,
} from "../../utils/secretsStore";

export interface SecretCommandResult {
  output: string;
}

/**
 * Handle the /secret command.
 * Usage:
 *   /secret set KEY value  - Set a secret
 *   /secret list           - List available secret names
 *   /secret unset KEY      - Unset a secret
 */
export async function handleSecretCommand(
  args: string[],
): Promise<SecretCommandResult> {
  const [subcommand, key, value] = args;

  switch (subcommand) {
    case "set": {
      if (!key) {
        return { output: "Usage: /secret set KEY value" };
      }
      if (!value) {
        return {
          output:
            "Usage: /secret set KEY value\nProvide a value for the secret.",
        };
      }

      const normalizedKey = key.toUpperCase();

      // Validate key format (must be valid for $SECRET_NAME pattern)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedKey)) {
        return {
          output: `Invalid secret name '${key}'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.`,
        };
      }

      try {
        await setSecretOnServer(normalizedKey, value);
        return { output: `Secret '$${normalizedKey}' set.` };
      } catch (error) {
        return {
          output: `Failed to set secret: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case "list": {
      const names = listSecretNames();

      if (names.length === 0) {
        return {
          output:
            "No secrets stored.\nUse /secret set KEY value to add a secret.",
        };
      }

      const lines = names.map((n) => `  $${n}`);
      return {
        output: `Available secrets (${names.length}):\n${lines.join("\n")}\n\nUse $SECRET_NAME in shell commands to reference them.`,
      };
    }

    case "unset":
    case "delete":
    case "remove":
    case "rm": {
      if (!key) {
        return { output: "Usage: /secret unset KEY" };
      }

      const normalizedKey = key.toUpperCase();

      try {
        const deleted = await deleteSecretOnServer(normalizedKey);

        if (deleted) {
          return { output: `Secret '$${normalizedKey}' unset.` };
        }

        return {
          output: `Secret '$${normalizedKey}' not found.\nUse /secret list to see available secrets.`,
        };
      } catch (error) {
        return {
          output: `Failed to unset secret: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case undefined:
    case "":
    case "help": {
      return {
        output: `Secret management commands:

  /secret set KEY value   Set a secret (KEY is normalized to uppercase)
  /secret list            List available secret names
  /secret unset KEY       Unset a secret

Secrets are stored on the Letta server. 
They must be all caps and can include underscores and numbers, but must start with a letter or underscore.
Your agent can use $SECRET_NAME in shell commands and the value will be substituted at runtime, without the secret value being leaked into context.`,
      };
    }

    default: {
      return {
        output: `Unknown subcommand '${subcommand}'.\nUse /secret help for usage.`,
      };
    }
  }
}
