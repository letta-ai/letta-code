import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { attachDeprecatedGetContextTrap } from "@/mods/deprecated-api";
import type { ModCommand, ModCommandContext, ModCommandResult } from "./types";

const MOD_COMMAND_TIMEOUT_MS = 30_000;

export function parseModSlashCommand(trimmed: string): {
  command: string;
  args: string;
} | null {
  if (!trimmed.startsWith("/")) return null;
  const commandToken = trimmed.split(/\s+/, 1)[0];
  if (!commandToken || commandToken === "/") return null;
  const command = commandToken.slice(1);
  if (!command || command.includes("/")) return null;
  return {
    command,
    args: trimmed.slice(commandToken.length).trim(),
  };
}

export function parseModCommandArgv(args: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      argv.push(current);
      current = "";
    }
  };

  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  pushCurrent();
  return argv;
}

export function normalizeModCommandResult(result: unknown): ModCommandResult {
  if (!result || typeof result !== "object" || !("type" in result)) {
    throw new Error(
      "Mod command must return { type: 'prompt' | 'output' | 'handled' }",
    );
  }

  const typed = result as {
    content?: unknown;
    output?: unknown;
    success?: unknown;
    systemReminder?: unknown;
    type?: unknown;
  };
  if (typed.type === "prompt") {
    if (typeof typed.content !== "string") {
      throw new Error("Mod command prompt result requires content");
    }
    return {
      type: "prompt",
      content: typed.content,
      ...(typeof typed.systemReminder === "boolean"
        ? { systemReminder: typed.systemReminder }
        : {}),
    };
  }
  if (typed.type === "output") {
    if (typeof typed.output !== "string") {
      throw new Error("Mod command output result requires output");
    }
    return {
      type: "output",
      output: typed.output,
      ...(typeof typed.success === "boolean" ? { success: typed.success } : {}),
    };
  }
  if (typed.type === "handled") {
    return { type: "handled" };
  }

  throw new Error(`Unknown mod command result type: ${String(typed.type)}`);
}

export function buildModCommandPrompt(result: {
  content: string;
  systemReminder?: boolean;
}): string {
  if (result.systemReminder === false) {
    return result.content;
  }
  return `${SYSTEM_REMINDER_OPEN}\n${result.content}\n${SYSTEM_REMINDER_CLOSE}`;
}

export async function runModCommandWithTimeout(
  command: ModCommand,
  context: ModCommandContext,
): Promise<ModCommandResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return normalizeModCommandResult(
      await Promise.race([
        Promise.resolve(
          command.run(
            attachDeprecatedGetContextTrap(
              context,
              command.recordDiagnostic,
              "ctx.getContext",
            ),
          ),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Mod command timed out after ${MOD_COMMAND_TIMEOUT_MS}ms`,
                ),
              ),
            MOD_COMMAND_TIMEOUT_MS,
          );
        }),
      ]),
    );
  } catch (error) {
    command.recordDiagnostic?.({
      capability: { id: command.id, kind: "command" },
      error: error instanceof Error ? error : new Error(String(error)),
      phase: "command.run",
    });
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
