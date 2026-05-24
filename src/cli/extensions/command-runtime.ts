import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import type {
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionCommandResult,
} from "./types";

const EXTENSION_COMMAND_TIMEOUT_MS = 30_000;

export function parseExtensionSlashCommand(trimmed: string): {
  command: string;
  args: string;
} | null {
  if (!trimmed.startsWith("/")) return null;
  const commandToken = trimmed.split(/\s+/, 1)[0];
  if (!commandToken || commandToken === "/") return null;
  return {
    command: commandToken.slice(1),
    args: trimmed.slice(commandToken.length).trim(),
  };
}

export function parseExtensionCommandArgv(args: string): string[] {
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

export function normalizeExtensionCommandResult(
  result: unknown,
): ExtensionCommandResult {
  if (!result || typeof result !== "object" || !("type" in result)) {
    throw new Error(
      "Extension command must return { type: 'prompt' | 'output' | 'handled' }",
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
      throw new Error("Extension command prompt result requires content");
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
      throw new Error("Extension command output result requires output");
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

  throw new Error(
    `Unknown extension command result type: ${String(typed.type)}`,
  );
}

export function buildExtensionCommandPrompt(result: {
  content: string;
  systemReminder?: boolean;
}): string {
  if (result.systemReminder === false) {
    return result.content;
  }
  return `${SYSTEM_REMINDER_OPEN}\n${result.content}\n${SYSTEM_REMINDER_CLOSE}`;
}

export async function runExtensionCommandWithTimeout(
  command: ExtensionCommand,
  context: ExtensionCommandContext,
): Promise<ExtensionCommandResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return normalizeExtensionCommandResult(
      await Promise.race([
        Promise.resolve(command.run(context)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Extension command timed out after ${EXTENSION_COMMAND_TIMEOUT_MS}ms`,
                ),
              ),
            EXTENSION_COMMAND_TIMEOUT_MS,
          );
        }),
      ]),
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
