/**
 * /secret command handler for managing secrets.
 * Secrets are stored in ~/.letta/secrets.json and can be referenced
 * via $SECRET_NAME syntax in shell commands.
 */

import {
  deleteSecret,
  listSecretNames,
  setSecret,
} from "../../utils/secretsStore";

export interface SecretCommandResult {
  output: string;
  /** Whether to trigger memory block sync */
  syncMemoryBlock?: boolean;
}

/**
 * Handle the /secret command.
 * Usage:
 *   /secret set KEY value  - Set a secret
 *   /secret list           - List available secret names
 *   /secret delete KEY     - Delete a secret
 */
export async function handleSecretCommand(
  args: string[],
): Promise<SecretCommandResult> {
  const [subcommand, key, ...valueParts] = args;

  switch (subcommand) {
    case "set": {
      if (!key) {
        return { output: "Usage: /secret set KEY value" };
      }
      if (valueParts.length === 0) {
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

      const value = valueParts.join(" ");
      setSecret(normalizedKey, value);

      return {
        output: `Secret '$${normalizedKey}' set.`,
        syncMemoryBlock: true,
      };
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

    case "delete":
    case "remove":
    case "rm": {
      if (!key) {
        return { output: "Usage: /secret delete KEY" };
      }

      const normalizedKey = key.toUpperCase();
      const deleted = deleteSecret(normalizedKey);

      if (deleted) {
        return {
          output: `Secret '$${normalizedKey}' deleted.`,
          syncMemoryBlock: true,
        };
      }

      return {
        output: `Secret '$${normalizedKey}' not found.\nUse /secret list to see available secrets.`,
      };
    }

    case undefined:
    case "":
    case "help": {
      return {
        output: `Secret management commands:

  /secret set KEY value   Set a secret (KEY is normalized to uppercase)
  /secret list            List available secret names
  /secret delete KEY      Delete a secret

Secrets are stored in ~/.letta/secrets.json
Use $SECRET_NAME in shell commands to reference them.
Example: curl -H "Authorization: Bearer $API_KEY" https://api.example.com`,
      };
    }

    default: {
      return {
        output: `Unknown subcommand '${subcommand}'.\nUse /secret help for usage.`,
      };
    }
  }
}
