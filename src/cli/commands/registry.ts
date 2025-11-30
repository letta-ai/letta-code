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
  "/clear": {
    desc: "Clear conversation history",
    handler: () => {
      // Handled specially in App.tsx to access client and agent ID
      return "Clearing messages...";
    },
  },
  "/logout": {
    desc: "Clear credentials and exit",
    handler: () => {
      // Handled specially in App.tsx to access settings manager
      return "Clearing credentials...";
    },
  },
  "/link": {
    desc: "Attach Letta Code tools to current agent",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Attaching tools...";
    },
  },
  "/unlink": {
    desc: "Remove Letta Code tools from current agent",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Removing tools...";
    },
  },
  "/rename": {
    desc: "Rename the current agent",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Renaming agent...";
    },
  },
  "/swap": {
    desc: "Switch to a different agent",
    handler: () => {
      // Handled specially in App.tsx to access agent list and client
      return "Swapping agent...";
    },
  },
  "/toolset": {
    desc: "Switch toolset (codex/default)",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Opening toolset selector...";
    },
  },
  "/system": {
    desc: "Switch system prompt",
    handler: () => {
      // Handled specially in App.tsx to open system prompt selector
      return "Opening system prompt selector...";
    },
  },
  "/download": {
    desc: "Download agent file locally",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Downloading agent file...";
    },
  },
  "/bashes": {
    desc: "Show background shell processes",
    handler: () => {
      // Handled specially in App.tsx to show background processes
      return "Showing background processes...";
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
