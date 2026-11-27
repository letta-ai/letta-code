import {
  type DreamCommandScope,
  requestCloudReflectionRun,
} from "@/agent/reflection-runs";
import { renderWorkflowTree } from "@/cli/helpers/workflow-display";
import { listWorkflowExecutions } from "@/tools/workflow/execution-registry";
import { handleMemoryRepositoryCommand } from "./memory-repository";
import { handleSecretCommand } from "./secret";
import { handleSystemRemindersCommand } from "./system-reminders";
import { handleVariableCommand } from "./variable";

type CommandHandlerResult =
  | string
  | {
      output: string;
      refreshSecretsInfo?: boolean;
    };

type CommandHandler = (
  args: string[],
  scope?: DreamCommandScope,
) => Promise<CommandHandlerResult> | CommandHandlerResult;

interface Command {
  desc: string;
  handler: CommandHandler;
  args?: string;
  hidden?: boolean;
  order?: number;
  noArgs?: boolean;
}

async function handleReflectionCommand(
  args: string[],
  scope?: DreamCommandScope,
) {
  if (!scope) throw new Error("Reflection requires an active agent.");
  const output = await requestCloudReflectionRun(scope, args.join(" "));
  if (output === null)
    throw new Error(
      "Run this command in the TUI or listener to launch Code-managed reflection.",
    );
  return output;
}

export const commands: Record<string, Command> = {
  "/agents": {
    desc: "Browse agents (pinned, Letta Code, all)",
    order: 10,
    noArgs: true,
    handler: () => {
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
      return "Initializing memory...";
    },
  },
  "/doctor": {
    desc: "Investigate an agent issue in this conversation",
    order: 12.1,
    args: "[symptom]",
    handler: () => {
      return "Starting doctor...";
    },
  },
  "/dream": {
    desc: "Reflect on memory (alias for /reflect; Cloud reflects this conversation)",
    order: 49,
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    handler: handleReflectionCommand,
  },
  "/reflect": {
    desc: "Launch reflection (/reflect [--recent N | --conversation ID ... | --auto] [--instruction TEXT])",
    args: "[--recent N | --conversation ID ... | --auto] [--instruction TEXT]",
    order: 50,
    handler: handleReflectionCommand,
  },
  "/skills": {
    desc: "Browse available skills",
    order: 28,
    noArgs: true,
    handler: () => {
      return "Opening skills browser...";
    },
  },
  "/skill-creator": {
    desc: "Enter skill creation mode (/skill-creator [description])",
    order: 28.5,
    handler: () => {
      return "Starting skill creation...";
    },
  },
  "/memory": {
    desc: "View your agent's memory",
    order: 15,
    noArgs: true,
    handler: () => {
      return "Opening memory viewer...";
    },
  },
  "/sleeptime": {
    desc: "Configure sleep-time reflection trigger and merge settings",
    order: 15.5,
    noArgs: true,
    handler: () => {
      return "Opening sleeptime settings...";
    },
  },
  "/compaction": {
    desc: "Configure compaction mode settings",
    order: 15.6,
    noArgs: true,
    handler: () => {
      return "Opening compaction settings...";
    },
  },
  "/context-limit": {
    desc: "Set or reset the max context window",
    args: "[tokens] [--override]",
    order: 15.7,
    handler: () => {
      return "Setting max context window...";
    },
  },
  "/search": {
    desc: "Search messages across all agents (/search [query])",
    order: 15.1,
    handler: () => {
      return "Opening message search...";
    },
  },
  "/connect": {
    desc: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
    order: 17,
    noArgs: true,
    handler: () => {
      return "Opening provider connection...";
    },
  },
  "/clear": {
    desc: "Clear in-context messages",
    order: 18,
    noArgs: true,
    handler: () => {
      return "Clearing in-context messages...";
    },
  },
  "/chdir": {
    desc: "Change working directory for this TUI session (/chdir <path>)",
    args: "<path>",
    order: 18.5,
    handler: () => {
      return "Changing working directory...";
    },
  },
  "/cd": {
    desc: "Alias for /chdir",
    args: "<path>",
    hidden: true,
    handler: () => {
      return "Changing working directory...";
    },
  },

  "/new": {
    desc: "Start a new conversation (keep agent memory)",
    order: 20,
    noArgs: true,
    handler: () => {
      return "Starting new conversation...";
    },
  },
  "/fork": {
    desc: "Fork the current conversation",
    order: 20.5,
    noArgs: true,
    handler: () => {
      return "Forking conversation...";
    },
  },
  "/btw": {
    desc: "Fork conversation and ask a side question (/btw <question>)",
    order: 20.6,
    handler: () => {
      return "Forking conversation...";
    },
  },
  "/pin": {
    desc: "Pin current agent (/pin [name])",
    order: 22,
    handler: () => {
      return "Pinning agent...";
    },
  },
  "/unpin": {
    desc: "Unpin current agent",
    order: 23,
    handler: () => {
      return "Unpinning agent...";
    },
  },
  "/rename": {
    desc: "Rename agent or conversation (/rename agent [name]|convo [name])",
    order: 24,
    handler: () => {
      return "Renaming...";
    },
  },
  "/description": {
    desc: "Update the current agent's description (/description <text>)",
    order: 25,
    handler: () => {
      return "Updating description...";
    },
  },
  "/toolset": {
    desc: "Switch toolset (replaces /link and /unlink)",
    order: 27,
    noArgs: true,
    handler: () => {
      return "Opening toolset selector...";
    },
  },
  "/experiments": {
    desc: "Toggle experiments",
    order: 27.1,
    handler: () => {
      return "Opening experiments selector...";
    },
  },
  "/reload": {
    desc: "Reload settings and local mods",
    order: 27.2,
    noArgs: true,
    handler: () => {
      return "Reloading...";
    },
  },
  "/mods": {
    desc: "Run mod learning targets",
    order: 27.3,
    args: "learn [memory-citations] [options] | generate-env [request]",
    handler: () => {
      return "Starting mod learning...";
    },
  },

  "/system": {
    desc: "Switch system prompt",
    order: 30,
    noArgs: true,
    handler: () => {
      return "Opening system prompt selector...";
    },
  },
  "/personality": {
    desc: "Switch personality",
    order: 30.5,
    noArgs: true,
    handler: () => {
      return "Opening personality selector...";
    },
  },
  "/subagents": {
    desc: "Manage custom subagents",
    order: 31,
    noArgs: true,
    handler: () => {
      return "Opening subagent manager...";
    },
  },
  "/mcp": {
    desc: "Manage MCP servers (add, connect with OAuth)",
    order: 32,
    handler: () => {
      return "Opening MCP server manager...";
    },
  },
  "/variable": {
    desc: "Manage plain variables for shell commands",
    order: 33.05,
    args: "<set|list|unset> [key] [value]",
    handler: (args: string[]) => handleVariableCommand(args),
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
      return "Fetching usage statistics...";
    },
  },
  "/context": {
    desc: "Show context window usage",
    order: 33.5,
    noArgs: true,
    handler: () => {
      return "Fetching context usage...";
    },
  },
  "/recompile": {
    desc: "Recompile current agent + conversation (warning: this will evict the cache and increase costs)",
    order: 33.6,
    noArgs: true,
    handler: () => {
      return "Recompiling agent and conversation...";
    },
  },
  "/feedback": {
    desc: "Send feedback to the Letta team",
    order: 34,
    handler: () => {
      return "Sending feedback...";
    },
  },
  "/help": {
    desc: "Show available commands",
    order: 35,
    hidden: true,
    noArgs: true,
    handler: () => {
      return "Opening help...";
    },
  },
  "/hooks": {
    desc: "Manage hooks configuration",
    order: 36,
    noArgs: true,
    handler: () => {
      return "Opening hooks manager...";
    },
  },
  "/statusline": {
    desc: "Customize the bottom statusline",
    args: "[request]",
    order: 36.5,
    handler: () => {
      return "Starting statusline setup...";
    },
  },
  "/title": {
    desc: "Configure terminal window title",
    noArgs: true,
    order: 36.6,
    handler: () => {
      return "Opening title configurator...";
    },
  },
  "/reasoning-tab": {
    desc: "Toggle Tab shortcut for reasoning tiers (/reasoning-tab on|off|status)",
    args: "[on|off|status]",
    order: 36.7,
    handler: () => {
      return "Managing reasoning Tab shortcut...";
    },
  },
  "/system-reminders": {
    desc: "Show or hide system reminders",
    args: "[on|off|status]",
    order: 36.8,
    handler: (args: string[]) => handleSystemRemindersCommand(args),
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
      return "Opening GitHub App installer...";
    },
  },

  "/bg": {
    desc: "Show background shell processes",
    order: 42,
    noArgs: true,
    handler: () => {
      return "Showing background processes...";
    },
  },
  "/workflows": {
    desc: "Show workflow runs, their agents, and token usage",
    order: 42.5,
    noArgs: true,
    handler: () => {
      const executions = listWorkflowExecutions();
      if (executions.length === 0) {
        return "No workflow runs in this session";
      }
      return executions.flatMap(renderWorkflowTree).join("\n");
    },
  },
  "/exit": {
    desc: "Exit this session",
    order: 43,
    noArgs: true,
    handler: () => {
      return "Exiting...";
    },
  },
  "/login": {
    desc: "Sign in with Letta",
    order: 43,
    noArgs: true,
    handler: () => {
      return "Signing in...";
    },
  },
  "/logout": {
    desc: "Clear saved credentials and exit",
    order: 44,
    noArgs: true,
    handler: () => {
      return "Clearing credentials...";
    },
  },

  "/compact": {
    desc: "Summarize conversation history (compaction) with optional mode",
    args: "[all|sliding_window|self_compact_all|self_compact_sliding_window]",
    handler: () => {
      return "Compacting conversation...";
    },
  },
  "/resume": {
    desc: "Resume a previous conversation",
    args: "[conversation_id]",
    order: 19,
    handler: () => {
      return "Opening conversation selector...";
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

export async function executeCommand(
  input: string,
  scope?: DreamCommandScope,
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
    const result = normalizeCommandHandlerResult(
      await handler.handler(args, scope),
    );
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      output: `Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
