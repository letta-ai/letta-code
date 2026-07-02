// src/cli/commands/registry.ts
// Registry of available CLI commands

import { handleMemoryRepositoryCommand } from "./memory-repository";
import { handleSecretCommand } from "./secret";

type CommandHandlerResult =
  | string
  | {
      output: string;
      refreshSecretsInfo?: boolean;
    };

type CommandHandler = (
  args: string[],
) => Promise<CommandHandlerResult> | CommandHandlerResult;

interface Command {
  desc: string;
  handler: CommandHandler;
  args?: string; // Optional argument syntax hint (e.g., "[conversation_id]", "<name>")
  hidden?: boolean; // Hidden commands don't show in autocomplete but still work
  order?: number; // Lower numbers appear first in autocomplete (default: 100)
  noArgs?: boolean; // If true, reject any arguments passed to this command
}

export const commands: Record<string, Command> = {
  // === Page 1: Most commonly used (order 10-19) ===
  "/agents": {
    desc: "Browse agents (pinned, Letta Code, all)",
    order: 10,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open agent browser
      return "Opening agent browser...";
    },
  },
  "/model": {
    desc: "Switch model",
    order: 11,
    noArgs: true,
    handler: () => {
      return "Opening model selector...";
    },
  },
  "/init": {
    desc: "Initialize (or re-init) your agent's memory",
    order: 12,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to send initialization prompt
      return "Initializing memory...";
    },
  },
  "/doctor": {
    desc: "Audit and refine your memory structure",
    order: 12.1,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to send doctor prompt
      return "Running memory doctor...";
    },
  },
  // TEMP/dev: dispatch only the memory-recap investigator against the current
  // agent + conversation (no new conversation, no doctor flow) for isolated
  // testing of the recap prompt. Remove before shipping.
  "/recap": {
    desc: "[dev] Dispatch the memory-recap investigator on the current agent",
    order: 12.11,
    noArgs: true,
    handler: () => {
      // Handled specially in use-submit-handler.ts
      return "Dispatching memory recap investigator...";
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
  "/reflect": {
    desc: "Launch reflection (/reflect [--recent N | --conversation ID ... | --auto] [--instruction TEXT])",
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    order: 50,
    handler: () => {
      // Handled specially in App.tsx
      return "Launching reflection agent...";
    },
  },
  "/reflection": {
    desc: "Alias for /reflect",
    args: "[transcript_file]",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Launching reflection agent...";
    },
  },
  "/skills": {
    desc: "Browse available skills",
    order: 28,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open skills browser overlay
      return "Opening skills browser...";
    },
  },
  "/skill-creator": {
    desc: "Enter skill creation mode (/skill-creator [description])",
    order: 28.5,
    handler: () => {
      // Handled specially in App.tsx to trigger skill-creation workflow
      return "Starting skill creation...";
    },
  },
  "/memory": {
    desc: "View your agent's memory",
    order: 15,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open memory viewer
      return "Opening memory viewer...";
    },
  },
  "/palace": {
    desc: "Open the Memory Palace in your browser",
    order: 16,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx - opens browser directly
      return "Opening Memory Palace...";
    },
  },
  "/sleeptime": {
    desc: "Configure sleep-time reflection trigger settings",
    order: 15.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open sleeptime settings
      return "Opening sleeptime settings...";
    },
  },
  "/compaction": {
    desc: "Configure compaction mode settings",
    order: 15.6,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open compaction settings
      return "Opening compaction settings...";
    },
  },
  "/context-limit": {
    desc: "Set or reset the max context window",
    args: "[tokens] [--override]",
    order: 15.7,
    handler: () => {
      // Handled specially in App.tsx
      return "Setting max context window...";
    },
  },
  "/memfs": {
    desc: "Manage filesystem-backed memory (/memfs [enable|disable|sync|reset])",
    args: "[enable|disable|sync|reset]",
    order: 27.5, // Advanced feature, near /toolset
    handler: () => {
      // Handled specially in App.tsx
      return "Managing memory filesystem...";
    },
  },
  "/search": {
    desc: "Search messages across all agents (/search [query])",
    order: 15.1,
    handler: () => {
      // Handled specially in App.tsx to show message search
      return "Opening message search...";
    },
  },
  "/connect": {
    desc: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
    order: 17,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx - opens ProviderSelector
      return "Opening provider connection...";
    },
  },
  "/clear": {
    desc: "Clear in-context messages",
    order: 18,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to reset agent messages
      return "Clearing in-context messages...";
    },
  },
  "/chdir": {
    desc: "Change working directory for this TUI session (/chdir <path>)",
    args: "<path>",
    order: 18.5,
    handler: () => {
      // Handled specially in App.tsx to switch local cwd
      return "Changing working directory...";
    },
  },
  "/cd": {
    desc: "Alias for /chdir",
    args: "<path>",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx to switch local cwd
      return "Changing working directory...";
    },
  },

  // === Page 2: Agent management (order 20-29) ===
  "/new": {
    desc: "Start a new conversation (keep agent memory)",
    order: 20,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to create new conversation
      return "Starting new conversation...";
    },
  },
  "/fork": {
    desc: "Fork the current conversation",
    order: 20.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to fork current conversation
      return "Forking conversation...";
    },
  },
  "/btw": {
    desc: "Fork conversation and ask a side question (/btw <question>)",
    order: 20.6,
    handler: () => {
      // Handled specially in App.tsx to fork and ask in background
      return "Forking conversation...";
    },
  },
  "/pin": {
    desc: "Pin current agent (/pin [name])",
    order: 22,
    handler: () => {
      // Handled specially in App.tsx
      return "Pinning agent...";
    },
  },
  "/unpin": {
    desc: "Unpin current agent",
    order: 23,
    handler: () => {
      // Handled specially in App.tsx
      return "Unpinning agent...";
    },
  },
  "/rename": {
    desc: "Rename agent or conversation (/rename agent [name]|convo [name])",
    order: 24,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Renaming...";
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
  "/export": {
    desc: "Export AgentFile (.af)",
    order: 26,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Exporting agent file...";
    },
  },
  "/toolset": {
    desc: "Switch toolset (replaces /link and /unlink)",
    order: 27,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Opening toolset selector...";
    },
  },
  "/experiments": {
    desc: "Toggle experiments",
    order: 27.1,
    handler: () => {
      // Handled specially in App.tsx to open experiments selector
      return "Opening experiments selector...";
    },
  },
  "/reload": {
    desc: "Reload settings and local mods",
    order: 27.2,
    noArgs: true,
    handler: () => {
      // Handled specially in AppCoordinator to reload runtime surfaces in-place
      return "Reloading...";
    },
  },
  "/mods": {
    desc: "Run mod learning targets",
    order: 27.3,
    args: "learn [memory-citations] [options] | generate-env [request]",
    handler: () => {
      // Handled specially in use-submit-handler.ts to stream mod learning progress
      return "Starting mod learning...";
    },
  },
  "/ade": {
    desc: "Open agent in ADE (browser)",
    order: 28,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and open browser
      return "Opening ADE...";
    },
  },

  // === Page 3: Advanced features (order 30-39) ===
  "/system": {
    desc: "Switch system prompt",
    order: 30,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open system prompt selector
      return "Opening system prompt selector...";
    },
  },
  "/personality": {
    desc: "Switch personality",
    order: 30.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open personality selector
      return "Opening personality selector...";
    },
  },
  "/subagents": {
    desc: "Manage custom subagents",
    order: 31,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open SubagentManager component
      return "Opening subagent manager...";
    },
  },
  "/mcp": {
    desc: "Manage MCP servers (add, connect with OAuth)",
    order: 32,
    handler: () => {
      // Handled specially in App.tsx to show MCP server selector
      return "Opening MCP server manager...";
    },
  },
  "/secret": {
    desc: "Manage secrets for shell commands",
    order: 33,
    args: "<set|list|unset> [key] [value]",
    handler: (args: string[]) => handleSecretCommand(args),
  },
  "/memory-repository": {
    desc: "Push this agent's memory repo to an additional git remote",
    order: 33.1,
    args: "<set|unset|status|push> [url]",
    handler: async (args: string[]) => {
      const result = await handleMemoryRepositoryCommand(args);
      return result.output;
    },
  },
  "/usage": {
    desc: "Show session usage statistics and balance",
    order: 33,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to display usage stats
      return "Fetching usage statistics...";
    },
  },
  "/context": {
    desc: "Show context window usage",
    order: 33.5,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to display context usage
      return "Fetching context usage...";
    },
  },
  "/recompile": {
    desc: "Recompile current agent + conversation (warning: this will evict the cache and increase costs)",
    order: 33.6,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Recompiling agent and conversation...";
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
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open help dialog
      return "Opening help...";
    },
  },
  "/hooks": {
    desc: "Manage hooks configuration",
    order: 36,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to open hooks manager
      return "Opening hooks manager...";
    },
  },
  "/statusline": {
    desc: "Customize the bottom statusline",
    args: "[request]",
    order: 36.5,
    handler: () => {
      // Handled specially in App.tsx
      return "Starting statusline setup...";
    },
  },
  "/title": {
    desc: "Configure terminal window title",
    noArgs: true,
    order: 36.6,
    handler: () => {
      // Handled specially in App.tsx
      return "Opening title configurator...";
    },
  },
  "/reasoning-tab": {
    desc: "Toggle Tab shortcut for reasoning tiers (/reasoning-tab on|off|status)",
    args: "[on|off|status]",
    order: 36.7,
    handler: () => {
      // Handled specially in App.tsx
      return "Managing reasoning Tab shortcut...";
    },
  },
  "/terminal": {
    desc: "Setup terminal shortcuts [--revert]",
    order: 37,
    handler: async (args: string[]) => {
      if (args.includes("help")) {
        return [
          "/terminal help",
          "",
          "Setup terminal keyboard shortcuts.",
          "",
          "USAGE",
          "  /terminal            — install Shift+Enter keybinding",
          "  /terminal --revert   — remove keybinding",
          "  /terminal help       — show this help",
        ].join("\n");
      }

      const {
        detectTerminalType,
        getKeybindingsPath,
        installKeybinding,
        removeKeybinding,
      } = await import("@/cli/utils/terminal-keybinding-installer");
      const { updateSettings } = await import("@/settings");

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
  "/install-github-app": {
    desc: "Setup Letta Code GitHub Action in this repo",
    order: 38,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Opening GitHub App installer...";
    },
  },

  // === Session management (order 40-49) ===
  "/bg": {
    desc: "Show background shell processes",
    order: 42,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to show background processes
      return "Showing background processes...";
    },
  },
  "/exit": {
    desc: "Exit this session",
    order: 43,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Exiting...";
    },
  },
  "/login": {
    desc: "Sign in to Letta Constellation",
    order: 43,
    noArgs: true,
    handler: () => {
      // Handled specially in use-submit-handler.ts
      return "Signing in...";
    },
  },
  "/logout": {
    desc: "Clear saved credentials and exit",
    order: 44,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access settings manager
      return "Clearing credentials...";
    },
  },

  // === Hidden commands (not shown in autocomplete) ===
  "/stream": {
    desc: "Toggle token streaming on/off",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx for live toggling
      return "Toggling token streaming...";
    },
  },
  "/compact": {
    desc: "Summarize conversation history (compaction) with optional mode",
    args: "[all|sliding_window|self_compact_all|self_compact_sliding_window]",
    handler: () => {
      // Handled specially in App.tsx to access client and agent ID
      return "Compacting conversation...";
    },
  },
  "/set-max-context": {
    desc: "Alias for /context-limit",
    args: "[tokens] [--override]",
    hidden: true,
    handler: () => {
      // Handled specially in App.tsx
      return "Setting max context window...";
    },
  },
  "/link": {
    desc: "Attach all Letta Code tools to agent (deprecated, use /toolset instead)",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Linking tools...";
    },
  },
  "/unlink": {
    desc: "Remove all Letta Code tools from agent (deprecated, use /toolset instead)",
    hidden: true,
    noArgs: true,
    handler: () => {
      // Handled specially in App.tsx to access agent ID and client
      return "Unlinking tools...";
    },
  },
  "/resume": {
    desc: "Resume a previous conversation",
    args: "[conversation_id]",
    order: 19,
    handler: () => {
      // Handled specially in App.tsx to show conversation selector or switch directly
      return "Opening conversation selector...";
    },
  },
  "/pinned": {
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    noArgs: true,
    handler: () => {
      return "Opening agent browser...";
    },
  },
  "/profiles": {
    desc: "Browse pinned agents",
    hidden: true, // Alias for /agents (opens to Pinned tab)
    noArgs: true,
    handler: () => {
      return "Opening agent browser...";
    },
  },
  "/download": {
    desc: "Export AgentFile (.af)",
    hidden: true, // Legacy alias for /export
    noArgs: true,
    handler: () => {
      return "Exporting agent file...";
    },
  },
};

export interface CommandExecutionResult {
  success: boolean;
  output: string;
  notFound?: boolean;
  refreshSecretsInfo?: boolean;
}

function normalizeCommandHandlerResult(result: CommandHandlerResult): {
  output: string;
  refreshSecretsInfo?: boolean;
} {
  if (typeof result === "string") {
    return { output: result };
  }
  return result;
}

/**
 * Execute a command and return the result
 */
export async function executeCommand(
  input: string,
): Promise<CommandExecutionResult> {
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
      notFound: true,
    };
  }

  if (handler.noArgs && args.length > 0) {
    return {
      success: false,
      output: `${command} does not accept arguments.`,
    };
  }

  try {
    const result = normalizeCommandHandlerResult(await handler.handler(args));
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      output: `Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
