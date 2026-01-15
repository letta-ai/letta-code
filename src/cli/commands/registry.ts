// src/cli/commands/registry.ts
// Registry of available CLI commands

type CommandHandler = (args: string[]) => Promise<string> | string;

interface Command {
  desc: string;
  handler: CommandHandler;
  hidden?: boolean; // Hidden commands don't show in autocomplete but still work
  order?: number; // Lower numbers appear first in autocomplete (default: 100)
}

export const commands: Record<string, Command> = {
  // === Page 1: Most commonly used (order 10-19) ===
  "/agents": {
    desc: "Browse agents (pinned, Letta Code, all)",
    order: 10,
    handler: () => {
      // Handled specially in App.tsx to open agent browser
      return "Opening agent browser...";
    },
  },
  "/model": {
    desc: "Switch model",
    order: 11,
    handler: () => {
      return "Opening model selector...";
    },
  },
  "/init": {
    desc: "Initialize (or re-init) your agent's memory",
    order: 12,
    handler: () => {
      // Handled specially in App.tsx to send initialization prompt
      return "Initializing memory...";
    },
  },
  "/remember": {
    desc: "Remember something from the conversation (/remember [instructions])",
    order: 13,
    handler: () => {
      // Handled specially in App.tsx to trigger memory update
      return "Processing memory request...";
    },
  },
  "/skill": {
    desc: "Enter skill creation mode (/skill [description])",
    order: 14,
    handler: () => {
      // Handled specially in App.tsx to trigger skill-creation workflow
      return "Starting skill creation...";
    },
  },
  "/memory": {
    desc: "View your agent's memory blocks",
    order: 15,
    handler: () => {
      // Handled specially in App.tsx to open memory viewer
      return "Opening memory viewer...";
    },
  },
  "/search": {
    desc: "Search messages across all agents",
    order: 16,
    handler: () => {
      // Handled specially in App.tsx to show message search
      return "Opening message search...";
    },
  },
  "/clear": {
    desc: "Clear conversation history (keep memory)",
    order: 17,
    handler: () => {
      // Handled specially in App.tsx to access client and agent ID
      return "Clearing messages...";
    },
  },

  // === Page 2: Agent management (order 20-29) ===
  "/new": {
    desc: "Create a new agent and switch to it",
    order: 20,
    handler: () => {
      // Handled specially in App.tsx
      return "Creating new agent...";
    },
  },
  "/pin": {
    desc: "Pin current agent globally, or use -l for local only",
    order: 22,
    handler: () => {
      // Handled specially in App.tsx
      return "Pinning agent...";
    },
  },
  "/unpin": {
    desc: "Unpin current agent globally, or use -l for local only",
    order: 23,
    handler: () => {
      // Handled specially in App.tsx
      return "Unpinning agent...";
    },
  },
  "/rename": {
    desc: "Rename the current agent (/rename <name>)",
    order: 24,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Renaming agent...";
    },
  },
  "/description": {
    desc: "Update the current agent's description (/description <text>)",
    order: 25,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Updating description...";
    },
  },
  "/download": {
    desc: "Download AgentFile (.af)",
    order: 26,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Downloading agent file...";
    },
  },
  "/toolset": {
    desc: "Switch toolset (replaces /link and /unlink)",
    order: 27,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Opening toolset selector...";
    },
  },
  "/ade": {
    desc: "Open agent in ADE (browser)",
    order: 28,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and open browser
      return "Opening ADE...";
    },
  },

  // === Page 3: Advanced features (order 30-39) ===
  "/system": {
    desc: "Switch system prompt",
    order: 30,
    handler: () => {
      // Handled specially in App.tsx to open system prompt selector
      return "Opening system prompt selector...";
    },
  },
  "/subagents": {
    desc: "Manage custom subagents",
    order: 31,
    handler: () => {
      // Handled specially in App.tsx to open SubagentManager component
      return "Opening subagent manager...";
    },
  },
  "/mcp": {
    desc: "Manage MCP servers",
    order: 32,
    handler: () => {
      // Handled specially in App.tsx to show MCP server selector
      return "Opening MCP server manager...";
    },
  },
  "/usage": {
    desc: "Show session usage statistics and balance",
    order: 33,
    handler: () => {
      // Handled specially in App.tsx to display usage stats
      return "Fetching usage statistics...";
    },
  },
  "/feedback": {
    desc: "Send feedback to the Letta team",
    order: 34,
    handler: () => {
      // Handled specially in App.tsx to send feedback request
      return "Sending feedback...";
    },
  },
  "/help": {
    desc: "Show available commands",
    order: 35,
    hidden: true, // Redundant with improved autocomplete, but still works if typed
    handler: () => {
      // Handled specially in App.tsx to open help dialog
      return "Opening help...";
    },
  },
  "/terminal": {
    desc: "Setup terminal shortcuts [--revert]",
    order: 36,
    handler: async (args: string[]) => {
      const {
        detectTerminalType,
        getKeybindingsPath,
        installKeybinding,
        removeKeybinding,
      } = await import("../utils/terminalKeybindingInstaller");
      const { updateSettings } = await import("../../settings");

      const isRevert = args.includes("--revert") || args.includes("--remove");
      const terminal = detectTerminalType();

      if (!terminal) {
        return "Not running in a VS Code-like terminal. Shift+Enter keybinding is not needed.";
      }

      const terminalName = {
        vscode: "VS Code",
        cursor: "Cursor",
        windsurf: "Windsurf",
      }[terminal];

      const keybindingsPath = getKeybindingsPath(terminal);
      if (!keybindingsPath) {
        return `Could not determine keybindings.json path for ${terminalName}`;
      }

      if (isRevert) {
        const result = removeKeybinding(keybindingsPath);
        if (!result.success) {
          return `Failed to remove keybinding: ${result.error}`;
        }
        await updateSettings({ shiftEnterKeybindingInstalled: false });
        return `Removed Shift+Enter keybinding from ${terminalName}`;
      }

      const result = installKeybinding(keybindingsPath);
      if (!result.success) {
        return `Failed to install keybinding: ${result.error}`;
      }

      if (result.alreadyExists) {
        return `Shift+Enter keybinding already exists in ${terminalName}`;
      }

      await updateSettings({ shiftEnterKeybindingInstalled: true });
      return `Installed Shift+Enter keybinding for ${terminalName}\nLocation: ${keybindingsPath}`;
    },
  },

  // === Session management (order 40-49) ===
  "/connect": {
    desc: "Connect an existing account (/connect codex or /connect zai <api-key>)",
    order: 40,
    handler: () => {
      // Handled specially in App.tsx
      return "Initiating account connection...";
    },
  },
  "/disconnect": {
    desc: "Disconnect an existing account (/disconnect codex|claude|zai)",
    order: 41,
    handler: () => {
      // Handled specially in App.tsx
      return "Disconnecting...";
    },
  },
  "/bg": {
    desc: "Show background shell processes",
    order: 42,
    handler: () => {
      // Handled specially in App.tsx to show background processes
      return "Showing background processes...";
    },
  },
  "/exit": {
    desc: "Exit this session",
    order: 43,
    handler: () => {
      // Handled specially in App.tsx
      return "Exiting...";
    },
  },
  "/logout": {
    desc: "Clear credentials and exit",
    order: 44,
    handler: () => {
      // Handled specially in App.tsx to access settings manager
      return "Clearing credentials...";
    },
  },

  // === Ralph Wiggum mode (order 45-46) ===
  "/ralph": {
    desc: 'Start Ralph Wiggum loop (/ralph [prompt] [--completion-promise "X"] [--max-iterations N])',
    order: 45,
    handler: () => {
      // Handled specially in App.tsx
      return "Activating ralph mode...";
    },
  },
  "/yolo-ralph": {
    desc: "Start Ralph loop with bypass permissions (yolo + ralph)",
    order: 46,
    handler: () => {
      // Handled specially in App.tsx
      return "Activating yolo-ralph mode...";
    },
  },

  // === Hidden commands (not shown in autocomplete) ===
  "/stream": {
    desc: "Toggle token streaming on/off",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx for live toggling
      return "Toggling token streaming...";
    },
  },
  "/compact": {
    desc: "Summarize conversation history (compaction)",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx to access client and agent ID
      return "Compacting conversation...";
    },
  },
  "/link": {
    desc: "Attach all Letta Code tools to agent (deprecated, use /toolset instead)",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Linking tools...";
    },
  },
  "/unlink": {
    desc: "Remove all Letta Code tools from agent (deprecated, use /toolset instead)",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Unlinking tools...";
    },
  },
  "/resume": {
    desc: "Browse and switch to another agent",
    hidden: true, // Backwards compatibility alias for /agents
    handler: () => {
      // Handled specially in App.tsx to show agent selector
      return "Opening agent selector...";
    },
  },
  "/pinned": {
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    handler: () => {
      return "Opening agent browser...";
    },
  },
  "/profiles": {
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    handler: () => {
      return "Opening agent browser...";
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
