// src/cli/commands/registry.ts
// Registry of available CLI commands

type CommandHandler = (args: string[]) => Promise<string> | string;

interface Command {
  desc: string;
  handler: CommandHandler;
  hidden?: boolean; // Hidden commands don't show in autocomplete but still work
}

export const commands: Record<string, Command> = {
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
  "/description": {
    desc: "Update the current agent's description",
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Updating description...";
    },
  },
  "/toolset": {
    desc: "Switch toolset",
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
    desc: "Download AgentFile (.af)",
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
  "/init": {
    desc: "Initialize agent memory for this project",
    handler: () => {
      // Handled specially in App.tsx to send initialization prompt
      return "Initializing memory...";
    },
  },
  "/skill": {
    desc: "Enter skill creation mode (optionally: /skill <description>)",
    handler: () => {
      // Handled specially in App.tsx to trigger skill-creation workflow
      return "Starting skill creation...";
    },
  },
  "/remember": {
    desc: "Remember something from the conversation",
    handler: () => {
      // Handled specially in App.tsx to trigger memory update
      return "Processing memory request...";
    },
  },
  "/resume": {
    desc: "Resume a previous agent session",
    handler: () => {
      // Handled specially in App.tsx to show resume selector
      return "Opening session selector...";
    },
  },
  "/search": {
    desc: "Search messages across all agents",
    handler: () => {
      // Handled specially in App.tsx to show message search
      return "Opening message search...";
    },
  },
  "/profile": {
    desc: "Manage local profiles (save/load/delete)",
    handler: () => {
      // Handled specially in App.tsx for profile management
      return "Managing profiles...";
    },
  },
  "/pin": {
    desc: "Pin current agent locally (use -g for global, <name> to rename)",
    handler: () => {
      // Handled specially in App.tsx
      return "Pinning agent...";
    },
  },
  "/unpin": {
    desc: "Unpin current agent locally (use -g for global)",
    handler: () => {
      // Handled specially in App.tsx
      return "Unpinning agent...";
    },
  },
  "/pinned": {
    desc: "Show pinned agents",
    handler: () => {
      // Handled specially in App.tsx to open pinned agents selector
      return "Opening pinned agents...";
    },
  },
  "/profiles": {
    desc: "Show pinned agents (alias for /pinned)",
    handler: () => {
      // Handled specially in App.tsx to open profile selector
      return "Opening pinned agents...";
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
