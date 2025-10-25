// src/cli/commands/registry.ts
// Registry of available CLI commands

type CommandHandler = (args: string[]) => Promise<string> | string;

interface Command {
  desc: string;
  handler: CommandHandler;
}

export const commands: Record<string, Command> = {
  "/agent": {
    desc: "Show agent link",
    handler: () => {
      // Handled specially in App.tsx to access agent ID
      return "Getting agent link...";
    },
  },
  "/model": {
    desc: "Switch model",
    handler: () => {
      return "Opening model selector...";
    },
  },
  "/stream": {
    desc: "Toggle token streaming on/off",
    handler: () => {
      // Handled specially in App.tsx for live toggling
      return "Toggling token streaming...";
    },
  },
  "/exit": {
    desc: "Exit and show session stats",
    handler: () => {
      // Handled specially in App.tsx to show stats
      return "Exiting...";
    },
  },
};

/**
 * Execute a command and return the result
 */
export async function executeCommand(
  input: string,
): Promise<{ success: boolean; output: string }> {
  const [command, ...args] = input.trim().split(/\s+/);

  if (!command) {
    return {
      success: false,
      output: "No command found",
    };
  }

  const handler = commands[command];
  if (!handler) {
    return {
      success: false,
      output: `Unknown command: ${command}`,
    };
  }

  try {
    const output = await handler.handler(args);
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: `Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
