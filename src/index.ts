#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeData, type ResumeData } from "./agent/check-approval";
import { getClient } from "./agent/client";
import {
  initializeLoadedSkillsFlag,
  setAgentContext,
  setConversationId as setContextConversationId,
} from "./agent/context";
import type { AgentProvenance } from "./agent/create";
import { getLettaCodeHeaders } from "./agent/http-headers";
import { ensureSkillsBlocks, ISOLATED_BLOCK_LABELS } from "./agent/memory";
import { LETTA_CLOUD_API_URL } from "./auth/oauth";
import { ConversationSelector } from "./cli/components/ConversationSelector";
import type { ApprovalRequest } from "./cli/helpers/stream";
import { ProfileSelectionInline } from "./cli/profile-selection";
import { runSubcommand } from "./cli/subcommands/router";
import { permissionMode } from "./permissions/mode";
import { settingsManager } from "./settings-manager";
import { telemetry } from "./telemetry";
import { loadTools } from "./tools/manager";
import { markMilestone } from "./utils/timing";

// Stable empty array constants to prevent new references on every render
// These are used as fallbacks when resumeData is null, avoiding the React
// anti-pattern of creating new [] on every render which triggers useEffect re-runs
const EMPTY_APPROVAL_ARRAY: ApprovalRequest[] = [];
const EMPTY_MESSAGE_ARRAY: Message[] = [];

function printHelp() {
  // Keep this plaintext (no colors) so output pipes cleanly
  const usage = `
Letta Code is a general purpose CLI for interacting with Letta agents

USAGE
  # interactive TUI
  letta                 Resume default conversation (OG single-threaded experience)
  letta --new           Create a new conversation (for concurrent sessions)
  letta --continue      Resume last session (agent + conversation) directly
  letta --resume        Open agent selector UI to pick agent/conversation
  letta --new-agent     Create a new agent directly (skip profile selector)
  letta --agent <id>    Open a specific agent by ID

  # headless
  letta -p "..."        One-off prompt in headless mode (no TTY UI)

  # maintenance
  letta update          Manually check for updates and install if available
  letta memfs ...       Memory filesystem subcommands (JSON-only)
  letta agents ...      Agents subcommands (JSON-only)
  letta messages ...    Messages subcommands (JSON-only)
  letta blocks ...      Blocks subcommands (JSON-only)

OPTIONS
  -h, --help            Show this help and exit
  -v, --version         Print version and exit
  --info                Show current directory, skills, and pinned agents
  --continue            Resume last session (agent + conversation) directly
  -r, --resume          Open agent selector UI after loading
  --new                 Create new conversation (for concurrent sessions)
  --new-agent           Create new agent directly (skip profile selection)
  --init-blocks <list>  Comma-separated memory blocks to initialize when using --new-agent (e.g., "persona,skills")
  --base-tools <list>   Comma-separated base tools to attach when using --new-agent (e.g., "memory,web_search,fetch_webpage")
  -a, --agent <id>      Use a specific agent ID
  -n, --name <name>     Resume agent by name (from pinned agents, case-insensitive)
  -m, --model <id>      Model ID or handle (e.g., "opus-4.5" or "anthropic/claude-opus-4-5")
  -s, --system <id>     System prompt ID or subagent name (applies to new or existing agent)
  --toolset <name>      Force toolset: "codex", "default", or "gemini" (overrides model-based auto-selection)
  -p, --prompt          Headless prompt mode
  --output-format <fmt> Output format for headless mode (text, json, stream-json)
                        Default: text
  --input-format <fmt>  Input format for headless mode (stream-json)
                        When set, reads JSON messages from stdin for bidirectional communication
  --include-partial-messages
                        Emit stream_event wrappers for each chunk (stream-json only)
  --from-agent <id>     Inject agent-to-agent system reminder (headless mode)
  --skills <path>       Custom path to skills directory (default: .skills in current directory)
  --sleeptime           Enable sleeptime memory management (only for new agents)
  --from-af <path>      Create agent from an AgentFile (.af) template
  --memfs               Enable memory filesystem for this agent
  --no-memfs            Disable memory filesystem for this agent

SUBCOMMANDS (JSON-only)
  letta memfs status --agent <id>
  letta memfs diff --agent <id>
  letta memfs resolve --agent <id> --resolutions '<JSON>'
  letta memfs backup --agent <id>
  letta memfs backups --agent <id>
  letta memfs restore --agent <id> --from <backup> --force
  letta memfs export --agent <id> --out <dir>
  letta agents list [--query <text> | --name <name> | --tags <tags>]
  letta messages search --query <text> [--all-agents]
  letta messages list [--agent <id>]
  letta messages start-conversation --agent <id> --message "<text>"
  letta messages continue-conversation --conversation-id <id> --message "<text>"
  letta blocks list --agent <id>
  letta blocks copy --block-id <id> [--label <label>] [--agent <id>] [--override]
  letta blocks attach --block-id <id> [--agent <id>] [--read-only] [--override]

BEHAVIOR
  On startup, Letta Code checks for saved profiles:
  - If profiles exist, you'll be prompted to select one or create a new agent
  - Profiles can be "pinned" to specific projects for quick access
  - Use /profile save <name> to bookmark your current agent

  Profiles are stored in:
  - Global: ~/.config/letta/settings.json (available everywhere)
  - Local: .letta/settings.local.json (pinned to project)

  If no credentials are configured, you'll be prompted to authenticate via
  Letta Cloud OAuth on first run.

EXAMPLES
  # when installed as an executable
  letta                    # Show profile selector or create new
  letta --new              # Create new conversation
  letta --agent agent_123  # Open specific agent

  # inside the interactive session
  /profile save MyAgent    # Save current agent as profile
  /profiles                # Open profile selector
  /pin                     # Pin current profile to project
  /unpin                   # Unpin profile from project
  /logout                  # Clear credentials and exit

  # headless with JSON output (includes stats)
  letta -p "hello" --output-format json

`.trim();

  console.log(usage);
}

/**
 * Print info about current directory, skills, and pinned agents
 */
async function printInfo() {
  const { join } = await import("node:path");
  const { getVersion } = await import("./version");
  const { SKILLS_DIR } = await import("./agent/skills");
  const { exists } = await import("./utils/fs");

  const cwd = process.cwd();
  const skillsDir = join(cwd, SKILLS_DIR);
  const skillsExist = exists(skillsDir);

  // Load local project settings first
  await settingsManager.loadLocalProjectSettings(cwd);

  // Get pinned agents
  const localPinned = settingsManager.getLocalPinnedAgents(cwd);
  const globalPinned = settingsManager.getGlobalPinnedAgents();
  const localSettings = settingsManager.getLocalProjectSettings(cwd);
  const lastAgent = localSettings.lastAgent;

  // Try to fetch agent names from API (if authenticated)
  const agentNames: Record<string, string> = {};
  const allAgentIds = [
    ...new Set([
      ...localPinned,
      ...globalPinned,
      ...(lastAgent ? [lastAgent] : []),
    ]),
  ];

  if (allAgentIds.length > 0) {
    try {
      const client = await getClient();
      // Fetch each agent individually to get accurate names
      await Promise.all(
        allAgentIds.map(async (id) => {
          try {
            const agent = await client.agents.retrieve(id);
            agentNames[id] = agent.name;
          } catch {
            // Agent not found or error - leave as not found
          }
        }),
      );
    } catch {
      // Not authenticated or API error - just show IDs
    }
  }

  const formatAgent = (id: string) => {
    const name = agentNames[id];
    return name ? `${id} (${name})` : `${id} (not found)`;
  };

  console.log(`Letta Code ${getVersion()}\n`);
  console.log(`Current directory: ${cwd}`);
  console.log(
    `Skills directory:  ${skillsDir}${skillsExist ? "" : " (not found)"}`,
  );

  console.log("");

  // Show which agent will be resumed
  if (lastAgent) {
    console.log(`Will resume: ${formatAgent(lastAgent)}`);
  } else if (localPinned.length > 0 || globalPinned.length > 0) {
    console.log("Will resume: (will show selector)");
  } else {
    console.log("Will resume: (will create new agent)");
  }

  console.log("");

  // Locally pinned agents
  if (localPinned.length > 0) {
    console.log("Locally pinned agents (this project):");
    for (const id of localPinned) {
      const isLast = id === lastAgent;
      const prefix = isLast ? "→ " : "  ";
      const suffix = isLast ? " (last used)" : "";
      console.log(`  ${prefix}${formatAgent(id)}${suffix}`);
    }
  } else {
    console.log("Locally pinned agents: (none)");
  }

  console.log("");

  // Globally pinned agents
  if (globalPinned.length > 0) {
    console.log("Globally pinned agents:");
    for (const id of globalPinned) {
      const isLocal = localPinned.includes(id);
      console.log(`    ${formatAgent(id)}${isLocal ? " (also local)" : ""}`);
    }
  } else {
    console.log("Globally pinned agents: (none)");
  }
}

/**
 * Helper to determine which model identifier to pass to loadTools()
 * based on user's model and/or toolset preferences.
 */
function getModelForToolLoading(
  specifiedModel?: string,
  specifiedToolset?: "codex" | "default" | "gemini",
): string | undefined {
  // If toolset is explicitly specified, use a dummy model from that provider
  // to trigger the correct toolset loading logic
  if (specifiedToolset === "codex") {
    return "openai/gpt-4";
  }
  if (specifiedToolset === "gemini") {
    return "google/gemini-3-pro";
  }
  if (specifiedToolset === "default") {
    return "anthropic/claude-sonnet-4";
  }
  // Otherwise, use the specified model (or undefined for auto-detection)
  return specifiedModel;
}

/**
 * Resolve an agent ID by name from pinned agents.
 * Case-insensitive exact match. If multiple matches, picks the most recently used.
 */
async function resolveAgentByName(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const client = await getClient();

  // Get all pinned agents (local first, then global, deduplicated)
  const localPinned = settingsManager.getLocalPinnedAgents();
  const globalPinned = settingsManager.getGlobalPinnedAgents();
  const allPinned = [...new Set([...localPinned, ...globalPinned])];

  if (allPinned.length === 0) {
    return null;
  }

  // Fetch names for all pinned agents and find matches
  const matches: { id: string; name: string }[] = [];
  const normalizedSearchName = name.toLowerCase();

  await Promise.all(
    allPinned.map(async (id) => {
      try {
        const agent = await client.agents.retrieve(id);
        if (agent.name?.toLowerCase() === normalizedSearchName) {
          matches.push({ id, name: agent.name });
        }
      } catch {
        // Agent not found or error, skip
      }
    }),
  );

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  // Multiple matches - pick most recently used
  // Check local LRU first
  const localSettings = settingsManager.getLocalProjectSettings();
  const localMatch = matches.find((m) => m.id === localSettings.lastAgent);
  if (localMatch) return localMatch;

  // Then global LRU
  const settings = settingsManager.getSettings();
  const globalMatch = matches.find((m) => m.id === settings.lastAgent);
  if (globalMatch) return globalMatch;

  // Fallback to first match (preserves local pinned order)
  return matches[0] ?? null;
}

/**
 * Get all pinned agent names for error messages
 */
async function getPinnedAgentNames(): Promise<{ id: string; name: string }[]> {
  const client = await getClient();
  const localPinned = settingsManager.getLocalPinnedAgents();
  const globalPinned = settingsManager.getGlobalPinnedAgents();
  const allPinned = [...new Set([...localPinned, ...globalPinned])];

  const agents: { id: string; name: string }[] = [];
  await Promise.all(
    allPinned.map(async (id) => {
      try {
        const agent = await client.agents.retrieve(id);
        agents.push({ id, name: agent.name || "(unnamed)" });
      } catch {
        // Agent not found, skip
      }
    }),
  );
  return agents;
}

async function main(): Promise<void> {
  markMilestone("CLI_START");

  // Initialize terminal theme detection (OSC 11 query with fallback)
  const { initTerminalTheme } = await import("./cli/helpers/terminalTheme");
  await initTerminalTheme();

  // Initialize settings manager (loads settings once into memory)
  await settingsManager.initialize();
  const settings = await settingsManager.getSettingsWithSecureTokens();
  markMilestone("SETTINGS_LOADED");

  // Handle CLI subcommands (e.g., `letta memfs ...`) before parsing global flags
  const subcommandResult = await runSubcommand(process.argv.slice(2));
  if (subcommandResult !== null) {
    process.exit(subcommandResult);
  }

  // Initialize LSP infrastructure for type checking
  if (process.env.LETTA_ENABLE_LSP) {
    try {
      const { lspManager } = await import("./lsp/manager.js");
      await lspManager.initialize(process.cwd());
    } catch (error) {
      console.error("[LSP] Failed to initialize:", error);
    }
  }

  // Initialize telemetry (enabled by default, opt-out via LETTA_CODE_TELEM=0)
  telemetry.init();

  // Check for updates on startup (non-blocking)
  const { checkAndAutoUpdate } = await import("./updater/auto-update");
  checkAndAutoUpdate()
    .then((result) => {
      // Surface ENOTEMPTY failures so users know how to fix
      if (result?.enotemptyFailed) {
        console.error(
          "\nAuto-update failed due to filesystem issue (ENOTEMPTY).",
        );
        console.error(
          "Fix: rm -rf $(npm prefix -g)/lib/node_modules/@letta-ai/letta-code && npm i -g @letta-ai/letta-code\n",
        );
      }
    })
    .catch(() => {
      // Silently ignore other update failures (network timeouts, etc.)
    });

  // Clean up old overflow files (non-blocking, 24h retention)
  const { cleanupOldOverflowFiles } = await import("./tools/impl/overflow");
  Promise.resolve().then(() => {
    try {
      cleanupOldOverflowFiles(process.cwd());
    } catch {
      // Silently ignore cleanup failures
    }
  });

  // Parse command-line arguments (Bun-idiomatic approach using parseArgs)
  // Preprocess args to support --conv as alias for --conversation
  const processedArgs = process.argv.map((arg) =>
    arg === "--conv" ? "--conversation" : arg,
  );

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: processedArgs,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        info: { type: "boolean" },
        continue: { type: "boolean" }, // Deprecated - kept for error message
        resume: { type: "boolean", short: "r" }, // Resume last session (or specific conversation with --conversation)
        conversation: { type: "string", short: "C" }, // Specific conversation ID to resume (--conv alias supported)
        default: { type: "boolean" }, // Alias for --conv default (use agent's default conversation)
        "new-agent": { type: "boolean" }, // Force create a new agent
        new: { type: "boolean" }, // Deprecated - kept for helpful error message
        "init-blocks": { type: "string" },
        "base-tools": { type: "string" },
        agent: { type: "string", short: "a" },
        name: { type: "string", short: "n" },
        model: { type: "string", short: "m" },
        system: { type: "string", short: "s" },
        "system-custom": { type: "string" },
        "system-append": { type: "string" },
        "memory-blocks": { type: "string" },
        "block-value": { type: "string", multiple: true },
        toolset: { type: "string" },
        prompt: { type: "boolean", short: "p" },
        run: { type: "boolean" },
        tools: { type: "string" },
        allowedTools: { type: "string" },
        disallowedTools: { type: "string" },
        "permission-mode": { type: "string" },
        yolo: { type: "boolean" },
        "output-format": { type: "string" },
        "input-format": { type: "string" },
        "include-partial-messages": { type: "boolean" },
        "from-agent": { type: "string" },
        skills: { type: "string" },
        sleeptime: { type: "boolean" },
        "from-af": { type: "string" },
        "no-skills": { type: "boolean" },
        memfs: { type: "boolean" },
        "no-memfs": { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Improve error message for common mistakes
    if (errorMsg.includes("Unknown option")) {
      console.error(`Error: ${errorMsg}`);
      console.error(
        "\nNote: Flags should use double dashes for full names (e.g., --yolo, not -yolo)",
      );
    } else {
      console.error(`Error: ${errorMsg}`);
    }
    console.error("Run 'letta --help' for usage information.");
    process.exit(1);
  }

  // Check for subcommands
  const command = positionals[2]; // First positional after node and script

  // Handle help flag first
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // Handle version flag
  if (values.version) {
    const { getVersion } = await import("./version");
    console.log(`${getVersion()} (Letta Code)`);
    process.exit(0);
  }

  // Handle info flag
  if (values.info) {
    await printInfo();
    process.exit(0);
  }

  // Handle update command
  if (command === "update") {
    const { manualUpdate } = await import("./updater/auto-update");
    const result = await manualUpdate();
    console.log(result.message);
    process.exit(result.success ? 0 : 1);
  }

  // --continue: Resume last session (agent + conversation) automatically
  const shouldContinue = (values.continue as boolean | undefined) ?? false;
  // --resume: Open agent selector UI after loading
  const shouldResume = (values.resume as boolean | undefined) ?? false;
  let specifiedConversationId =
    (values.conversation as string | undefined) ?? null; // Specific conversation to resume
  const useDefaultConv = (values.default as boolean | undefined) ?? false; // --default flag
  const forceNew = (values["new-agent"] as boolean | undefined) ?? false;

  // Handle --default flag (alias for --conv default)
  if (useDefaultConv) {
    if (specifiedConversationId && specifiedConversationId !== "default") {
      console.error(
        "Error: --default cannot be used with --conversation (they're mutually exclusive)",
      );
      process.exit(1);
    }
    specifiedConversationId = "default";
  }

  // --new: Create a new conversation (for concurrent sessions)
  const forceNewConversation = (values.new as boolean | undefined) ?? false;

  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  let specifiedAgentId = (values.agent as string | undefined) ?? null;

  // Handle --conv {agent-id} shorthand: --conv agent-xyz → --agent agent-xyz --conv default
  if (specifiedConversationId?.startsWith("agent-")) {
    if (specifiedAgentId && specifiedAgentId !== specifiedConversationId) {
      console.error(
        `Error: Conflicting agent IDs: --agent ${specifiedAgentId} vs --conv ${specifiedConversationId}`,
      );
      process.exit(1);
    }
    specifiedAgentId = specifiedConversationId;
    specifiedConversationId = "default";
  }

  // Validate --conv default requires --agent
  if (specifiedConversationId === "default" && !specifiedAgentId) {
    console.error("Error: --conv default requires --agent <agent-id>");
    console.error("Usage: letta --agent agent-xyz --conv default");
    console.error("   or: letta --conv agent-xyz (shorthand)");
    process.exit(1);
  }

  const specifiedAgentName = (values.name as string | undefined) ?? null;
  const specifiedModel = (values.model as string | undefined) ?? undefined;
  const systemPromptPreset = (values.system as string | undefined) ?? undefined;
  const systemCustom =
    (values["system-custom"] as string | undefined) ?? undefined;
  // Note: systemAppend is also parsed but only used in headless mode (headless.ts handles it)
  const memoryBlocksJson =
    (values["memory-blocks"] as string | undefined) ?? undefined;
  const specifiedToolset = (values.toolset as string | undefined) ?? undefined;
  const skillsDirectory = (values.skills as string | undefined) ?? undefined;
  const sleeptimeFlag = (values.sleeptime as boolean | undefined) ?? undefined;
  const memfsFlag = values.memfs as boolean | undefined;
  const noMemfsFlag = values["no-memfs"] as boolean | undefined;
  const fromAfFile = values["from-af"] as string | undefined;
  const isHeadless = values.prompt || values.run || !process.stdin.isTTY;

  // Fail if an unknown command/argument is passed (and we're not in headless mode where it might be a prompt)
  if (command && !isHeadless) {
    console.error(`Error: Unknown command or argument "${command}"`);
    console.error("Run 'letta --help' for usage information.");
    process.exit(1);
  }

  // --init-blocks only makes sense when creating a brand new agent
  if (initBlocksRaw && !forceNew) {
    console.error(
      "Error: --init-blocks can only be used together with --new to control initial memory blocks.",
    );
    process.exit(1);
  }

  let initBlocks: string[] | undefined;
  if (initBlocksRaw !== undefined) {
    const trimmed = initBlocksRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      // Explicitly requested zero blocks
      initBlocks = [];
    } else {
      initBlocks = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

  // --base-tools only makes sense when creating a brand new agent
  if (baseToolsRaw && !forceNew) {
    console.error(
      "Error: --base-tools can only be used together with --new to control initial base tools.",
    );
    process.exit(1);
  }

  let baseTools: string[] | undefined;
  if (baseToolsRaw !== undefined) {
    const trimmed = baseToolsRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      baseTools = [];
    } else {
      baseTools = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

  // Validate toolset if provided
  if (
    specifiedToolset &&
    specifiedToolset !== "codex" &&
    specifiedToolset !== "default" &&
    specifiedToolset !== "gemini"
  ) {
    console.error(
      `Error: Invalid toolset "${specifiedToolset}". Must be "codex", "default", or "gemini".`,
    );
    process.exit(1);
  }

  // Validate system prompt options (--system and --system-custom are mutually exclusive)
  if (systemPromptPreset && systemCustom) {
    console.error(
      "Error: --system and --system-custom are mutually exclusive. Use one or the other.",
    );
    process.exit(1);
  }

  // Validate system prompt preset if provided (can be a system prompt ID or subagent name)
  if (systemPromptPreset) {
    const { SYSTEM_PROMPTS } = await import("./agent/promptAssets");
    const { getAllSubagentConfigs } = await import("./agent/subagents");

    const validSystemPrompts = SYSTEM_PROMPTS.map((p) => p.id);
    const subagentConfigs = await getAllSubagentConfigs();
    const validSubagentNames = Object.keys(subagentConfigs);

    const isValidSystemPrompt = validSystemPrompts.includes(systemPromptPreset);
    const isValidSubagent = validSubagentNames.includes(systemPromptPreset);

    if (!isValidSystemPrompt && !isValidSubagent) {
      const allValid = [...validSystemPrompts, ...validSubagentNames];
      console.error(
        `Error: Invalid system prompt "${systemPromptPreset}". Must be one of: ${allValid.join(", ")}.`,
      );
      process.exit(1);
    }
  }

  // Parse memory blocks JSON if provided
  let memoryBlocks:
    | Array<{ label: string; value: string; description?: string }>
    | undefined;
  if (memoryBlocksJson) {
    try {
      memoryBlocks = JSON.parse(memoryBlocksJson);
      if (!Array.isArray(memoryBlocks)) {
        throw new Error("memory-blocks must be a JSON array");
      }
      // Validate each block has required fields
      for (const block of memoryBlocks) {
        if (
          typeof block.label !== "string" ||
          typeof block.value !== "string"
        ) {
          throw new Error(
            "Each memory block must have 'label' and 'value' string fields",
          );
        }
      }
    } catch (error) {
      console.error(
        `Error: Invalid --memory-blocks JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Validate --conversation flag (mutually exclusive with agent-selection flags)
  // Exception: --conv default requires --agent
  if (specifiedConversationId && specifiedConversationId !== "default") {
    if (specifiedAgentId) {
      console.error("Error: --conversation cannot be used with --agent");
      process.exit(1);
    }
    if (specifiedAgentName) {
      console.error("Error: --conversation cannot be used with --name");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --conversation cannot be used with --new-agent");
      process.exit(1);
    }
    if (fromAfFile) {
      console.error("Error: --conversation cannot be used with --from-af");
      process.exit(1);
    }
    if (shouldResume) {
      console.error("Error: --conversation cannot be used with --resume");
      process.exit(1);
    }
    if (shouldContinue) {
      console.error("Error: --conversation cannot be used with --continue");
      process.exit(1);
    }
  }

  // Validate --new flag (create new conversation)
  if (forceNewConversation) {
    if (shouldContinue) {
      console.error("Error: --new cannot be used with --continue");
      process.exit(1);
    }
    if (specifiedConversationId) {
      console.error("Error: --new cannot be used with --conversation");
      process.exit(1);
    }
    if (shouldResume) {
      console.error("Error: --new cannot be used with --resume");
      process.exit(1);
    }
  }

  // Validate --from-af flag
  if (fromAfFile) {
    if (specifiedAgentId) {
      console.error("Error: --from-af cannot be used with --agent");
      process.exit(1);
    }
    if (specifiedAgentName) {
      console.error("Error: --from-af cannot be used with --name");
      process.exit(1);
    }
    if (shouldResume) {
      console.error("Error: --from-af cannot be used with --resume");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --from-af cannot be used with --new");
      process.exit(1);
    }
    // Verify file exists
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const resolvedPath = resolve(fromAfFile);
    if (!existsSync(resolvedPath)) {
      console.error(`Error: AgentFile not found: ${resolvedPath}`);
      process.exit(1);
    }
  }

  // Validate --name flag
  if (specifiedAgentName) {
    if (specifiedAgentId) {
      console.error("Error: --name cannot be used with --agent");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --name cannot be used with --new");
      process.exit(1);
    }
  }

  // Check if API key is configured
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  // Check if refresh token is missing for Letta Cloud (only when not using env var)
  // Skip this check if we already have an API key from env
  if (
    !isHeadless &&
    baseURL === LETTA_CLOUD_API_URL &&
    !settings.refreshToken &&
    !apiKey
  ) {
    // For interactive mode, show setup flow
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main().catch((err: unknown) => {
      // Handle top-level errors gracefully without raw stack traces
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      console.error(`\nError: ${message}`);
      if (process.env.DEBUG) {
        console.error(err);
      }
      process.exit(1);
    });
  }

  if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
    // For headless mode, error out (assume automation context)
    if (isHeadless) {
      console.error("Missing LETTA_API_KEY");
      console.error(
        "Run 'letta' in interactive mode to authenticate or export the missing environment variable",
      );
      process.exit(1);
    }

    // For interactive mode, show setup flow
    console.log("No credentials found. Let's get you set up!\n");
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main();
  }

  // Validate credentials by checking health endpoint
  const { validateCredentials } = await import("./auth/oauth");
  const isValid = await validateCredentials(baseURL, apiKey ?? "");
  markMilestone("CREDENTIALS_VALIDATED");

  if (!isValid) {
    // For headless mode, error out with helpful message
    if (isHeadless) {
      console.error("Failed to connect to Letta server");
      console.error(`Base URL: ${baseURL}`);
      console.error(
        "Your credentials may be invalid or the server may be unreachable.",
      );
      console.error(
        "Delete ~/.config/letta/settings.json then run 'letta' to re-authenticate",
      );
      process.exit(1);
    }

    // For interactive mode, show setup flow
    console.log("Failed to connect to Letta server.");
    console.log(`Base URL: ${baseURL}\n`);
    console.log(
      "Your credentials may be invalid or the server may be unreachable.",
    );
    console.log("Let's reconfigure your setup.\n");
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main();
  }

  // Resolve --name to agent ID if provided
  if (specifiedAgentName) {
    // Load local settings for LRU priority
    await settingsManager.loadLocalProjectSettings();

    const resolved = await resolveAgentByName(specifiedAgentName);
    if (!resolved) {
      console.error(
        `Error: No pinned agent found with name "${specifiedAgentName}"`,
      );
      console.error("");
      const pinnedAgents = await getPinnedAgentNames();
      if (pinnedAgents.length > 0) {
        console.error("Available pinned agents:");
        for (const agent of pinnedAgents) {
          console.error(`  - "${agent.name}" (${agent.id})`);
        }
      } else {
        console.error(
          "No pinned agents available. Use /pin to pin an agent first.",
        );
      }
      process.exit(1);
    }
    specifiedAgentId = resolved.id;
  }

  // Set tool filter if provided (controls which tools are loaded)
  if (values.tools !== undefined) {
    const { toolFilter } = await import("./tools/filter");
    toolFilter.setEnabledTools(values.tools as string);
  }

  // Set CLI permission overrides if provided
  if (values.allowedTools || values.disallowedTools) {
    const { cliPermissions } = await import("./permissions/cli");
    if (values.allowedTools) {
      cliPermissions.setAllowedTools(values.allowedTools as string);
    }
    if (values.disallowedTools) {
      cliPermissions.setDisallowedTools(values.disallowedTools as string);
    }
  }

  // Set permission mode if provided (or via --yolo alias)
  const permissionModeValue = values["permission-mode"] as string | undefined;
  const yoloMode = values.yolo as boolean | undefined;

  if (yoloMode || permissionModeValue) {
    if (yoloMode) {
      // --yolo is an alias for --permission-mode bypassPermissions
      permissionMode.setMode("bypassPermissions");
    } else if (permissionModeValue) {
      const mode = permissionModeValue;
      const validModes = [
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ] as const;

      if (validModes.includes(mode as (typeof validModes)[number])) {
        permissionMode.setMode(mode as (typeof validModes)[number]);
      } else {
        console.error(
          `Invalid permission mode: ${mode}. Valid modes: ${validModes.join(", ")}`,
        );
        process.exit(1);
      }
    }
  }

  if (isHeadless) {
    markMilestone("HEADLESS_MODE_START");
    // For headless mode, load tools synchronously (respecting model/toolset when provided)
    const modelForTools = getModelForToolLoading(
      specifiedModel,
      specifiedToolset as "codex" | "default" | undefined,
    );
    await loadTools(modelForTools);
    markMilestone("TOOLS_LOADED");

    const { handleHeadlessCommand } = await import("./headless");
    await handleHeadlessCommand(process.argv, specifiedModel, skillsDirectory);
    return;
  }

  markMilestone("TUI_MODE_START");

  // Enable enhanced key reporting (Shift+Enter, etc.) BEFORE Ink initializes.
  // In VS Code/xterm.js this typically requires a short handshake (query + enable).
  try {
    const { detectAndEnableKittyProtocol } = await import(
      "./cli/utils/kittyProtocolDetector"
    );
    await detectAndEnableKittyProtocol();
  } catch {
    // Best-effort: if this fails, the app still runs (Option+Enter remains supported).
  }

  // Interactive: lazy-load React/Ink + App
  markMilestone("REACT_IMPORT_START");
  const React = await import("react");
  const { render } = await import("ink");
  const { useState, useEffect } = React;
  const AppModule = await import("./cli/App");
  const App = AppModule.default;

  function LoadingApp({
    continueSession,
    forceNew,
    initBlocks,
    baseTools,
    agentIdArg,
    model,
    systemPromptPreset,
    toolset,
    skillsDirectory,
    fromAfFile,
  }: {
    continueSession: boolean;
    forceNew: boolean;
    initBlocks?: string[];
    baseTools?: string[];
    agentIdArg: string | null;
    model?: string;
    systemPromptPreset?: string;
    toolset?: "codex" | "default" | "gemini";
    skillsDirectory?: string;
    fromAfFile?: string;
  }) {
    const [showKeybindingSetup, setShowKeybindingSetup] = useState<
      boolean | null
    >(null);
    const [loadingState, setLoadingState] = useState<
      | "selecting"
      | "selecting_global"
      | "selecting_conversation"
      | "assembling"
      | "importing"
      | "initializing"
      | "checking"
      | "ready"
    >("selecting");
    const [agentId, setAgentId] = useState<string | null>(null);
    const [agentState, setAgentState] = useState<AgentState | null>(null);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [resumeData, setResumeData] = useState<ResumeData | null>(null);
    const [isResumingSession, setIsResumingSession] = useState(false);
    const [resumedExistingConversation, setResumedExistingConversation] =
      useState(false);
    const [agentProvenance, setAgentProvenance] =
      useState<AgentProvenance | null>(null);
    const [selectedGlobalAgentId, setSelectedGlobalAgentId] = useState<
      string | null
    >(null);
    // Track agent and conversation for conversation selector (--resume flag)
    const [resumeAgentId, setResumeAgentId] = useState<string | null>(null);
    const [resumeAgentName, setResumeAgentName] = useState<string | null>(null);
    const [selectedConversationId, setSelectedConversationId] = useState<
      string | null
    >(null);
    // Track when user explicitly requested new agent from selector (not via --new flag)
    const [userRequestedNewAgent, setUserRequestedNewAgent] = useState(false);
    // Message to show when LRU/selected agent failed to load
    const [failedAgentMessage, setFailedAgentMessage] = useState<string | null>(
      null,
    );
    // For self-hosted: available model handles from server and user's selection
    const [availableServerModels, setAvailableServerModels] = useState<
      string[]
    >([]);
    const [selectedServerModel, setSelectedServerModel] = useState<
      string | null
    >(null);
    const [selfHostedDefaultModel, setSelfHostedDefaultModel] = useState<
      string | null
    >(null);
    const [selfHostedBaseUrl, setSelfHostedBaseUrl] = useState<string | null>(
      null,
    );

    // Release notes to display (checked once on mount)
    const [releaseNotes, setReleaseNotes] = useState<string | null>(null);

    // Auto-install Shift+Enter keybinding for VS Code/Cursor/Windsurf (silent, no prompt)
    useEffect(() => {
      async function autoInstallKeybinding() {
        const {
          detectTerminalType,
          getKeybindingsPath,
          keybindingExists,
          installKeybinding,
        } = await import("./cli/utils/terminalKeybindingInstaller");
        const { loadSettings, updateSettings } = await import("./settings");

        const terminal = detectTerminalType();
        if (!terminal) {
          setShowKeybindingSetup(false);
          return;
        }

        const settings = await loadSettings();
        const keybindingsPath = getKeybindingsPath(terminal);

        // Skip if already installed or no valid path
        if (!keybindingsPath || settings.shiftEnterKeybindingInstalled) {
          setShowKeybindingSetup(false);
          return;
        }

        // Check if keybinding already exists (user might have added it manually)
        if (keybindingExists(keybindingsPath)) {
          await updateSettings({ shiftEnterKeybindingInstalled: true });
          setShowKeybindingSetup(false);
          return;
        }

        // Silently install keybinding (no prompt, just like Claude Code)
        const result = installKeybinding(keybindingsPath);
        if (result.success) {
          await updateSettings({ shiftEnterKeybindingInstalled: true });
        }

        setShowKeybindingSetup(false);
      }

      async function autoInstallWezTermFix() {
        const {
          isWezTerm,
          wezTermDeleteFixExists,
          getWezTermConfigPath,
          installWezTermDeleteFix,
        } = await import("./cli/utils/terminalKeybindingInstaller");
        const { loadSettings, updateSettings } = await import("./settings");

        if (!isWezTerm()) return;

        const settings = await loadSettings();
        if (settings.wezTermDeleteFixInstalled) return;

        const configPath = getWezTermConfigPath();
        if (wezTermDeleteFixExists(configPath)) {
          await updateSettings({ wezTermDeleteFixInstalled: true });
          return;
        }

        // Silently install the fix
        const result = installWezTermDeleteFix();
        if (result.success) {
          await updateSettings({ wezTermDeleteFixInstalled: true });
        }
      }

      autoInstallKeybinding();
      autoInstallWezTermFix();
    }, []);

    // Check for release notes to display (runs once on mount)
    useEffect(() => {
      async function checkNotes() {
        const { checkReleaseNotes } = await import("./release-notes");
        const notes = await checkReleaseNotes();
        setReleaseNotes(notes);
      }
      checkNotes();
    }, []);

    // Initialize on mount - check if we should show global agent selector
    useEffect(() => {
      async function checkAndStart() {
        // Load settings
        await settingsManager.loadLocalProjectSettings();
        const localSettings = settingsManager.getLocalProjectSettings();
        const globalPinned = settingsManager.getGlobalPinnedAgents();
        const client = await getClient();

        // For self-hosted servers, pre-fetch available models
        // This is needed so ProfileSelectionInline can show model picker
        // if the default model isn't available
        const baseURL =
          process.env.LETTA_BASE_URL ||
          settings.env?.LETTA_BASE_URL ||
          LETTA_CLOUD_API_URL;
        const isSelfHosted = !baseURL.includes("api.letta.com");

        // Track whether we need model picker (for skipping ensureDefaultAgents)
        let needsModelPicker = false;

        if (isSelfHosted) {
          setSelfHostedBaseUrl(baseURL);
          try {
            const { getDefaultModel } = await import("./agent/model");
            const defaultModel = getDefaultModel();
            setSelfHostedDefaultModel(defaultModel);
            const modelsList = await client.models.list();
            const handles = modelsList
              .map((m) => m.handle)
              .filter((h): h is string => typeof h === "string");

            // Only set if default model isn't available
            if (!handles.includes(defaultModel)) {
              setAvailableServerModels(handles);
              needsModelPicker = true;
            }
          } catch {
            // Ignore errors - will fail naturally during agent creation if needed
          }
        }

        // =====================================================================
        // TOP-LEVEL PATH: --conversation <id>
        // Conversation ID is unique, so we can derive the agent from it
        // (except for "default" which requires --agent flag, validated above)
        // =====================================================================
        if (specifiedConversationId) {
          if (specifiedConversationId === "default") {
            // "default" requires --agent (validated in flag preprocessing above)
            // Use the specified agent directly, skip conversation validation
            // TypeScript can't see the validation above, but specifiedAgentId is guaranteed
            if (!specifiedAgentId) {
              throw new Error("Unreachable: --conv default requires --agent");
            }
            setSelectedGlobalAgentId(specifiedAgentId);
            setSelectedConversationId("default");
            setLoadingState("assembling");
            return;
          }

          // For explicit conversations, derive agent from conversation
          try {
            const conversation = await client.conversations.retrieve(
              specifiedConversationId,
            );
            // Use the agent that owns this conversation
            setSelectedGlobalAgentId(conversation.agent_id);
            setSelectedConversationId(specifiedConversationId);
            setLoadingState("assembling");
            return;
          } catch (error) {
            if (
              error instanceof APIError &&
              (error.status === 404 || error.status === 422)
            ) {
              console.error(
                `Conversation ${specifiedConversationId} not found`,
              );
              process.exit(1);
            }
            throw error;
          }
        }

        // =====================================================================
        // TOP-LEVEL PATH: --resume
        // Show conversation selector for last-used agent (local → global fallback)
        // =====================================================================
        if (shouldResume) {
          const localSession = settingsManager.getLocalLastSession(
            process.cwd(),
          );
          const localAgentId = localSession?.agentId ?? localSettings.lastAgent;

          // Try local LRU first
          if (localAgentId) {
            try {
              const agent = await client.agents.retrieve(localAgentId);
              setResumeAgentId(localAgentId);
              setResumeAgentName(agent.name ?? null);
              setLoadingState("selecting_conversation");
              return;
            } catch {
              // Local agent doesn't exist, try global
              setFailedAgentMessage(
                `Unable to locate agent ${localAgentId} in .letta/, checking global (~/.letta)`,
              );
            }
          } else {
            // No recent agent locally, silently fall through to global
          }

          // Try global LRU
          const globalSession = settingsManager.getGlobalLastSession();
          const globalAgentId = globalSession?.agentId;
          if (globalAgentId) {
            try {
              const agent = await client.agents.retrieve(globalAgentId);
              setResumeAgentId(globalAgentId);
              setResumeAgentName(agent.name ?? null);
              setLoadingState("selecting_conversation");
              return;
            } catch {
              // Global agent also doesn't exist
            }
          }

          // No valid agent found anywhere
          console.error("No recent session found in .letta/ or ~/.letta.");
          console.error("Run 'letta' to get started.");
          process.exit(1);
        }

        // =====================================================================
        // TOP-LEVEL PATH: --continue
        // Resume last session directly (local → global fallback)
        // =====================================================================
        if (continueSession) {
          const localSession = settingsManager.getLocalLastSession(
            process.cwd(),
          );
          const localAgentId = localSession?.agentId ?? localSettings.lastAgent;

          // Try local LRU first
          if (localAgentId) {
            try {
              await client.agents.retrieve(localAgentId);
              setSelectedGlobalAgentId(localAgentId);
              if (localSession?.conversationId) {
                setSelectedConversationId(localSession.conversationId);
              }
              setLoadingState("assembling");
              return;
            } catch {
              // Local agent doesn't exist, try global
              setFailedAgentMessage(
                `Unable to locate agent ${localAgentId} in .letta/, checking global (~/.letta)`,
              );
            }
          } else {
            console.log("No recent agent in .letta/, using global (~/.letta)");
          }

          // Try global LRU
          const globalSession = settingsManager.getGlobalLastSession();
          const globalAgentId = globalSession?.agentId;
          if (globalAgentId) {
            try {
              await client.agents.retrieve(globalAgentId);
              setSelectedGlobalAgentId(globalAgentId);
              if (globalSession?.conversationId) {
                setSelectedConversationId(globalSession.conversationId);
              }
              setLoadingState("assembling");
              return;
            } catch {
              // Global agent also doesn't exist
            }
          }

          // No valid agent found anywhere
          console.error("No recent session found in .letta/ or ~/.letta.");
          console.error("Run 'letta' to get started.");
          process.exit(1);
        }

        // =====================================================================
        // DEFAULT PATH: No special flags
        // Check local LRU, then selector, then defaults
        // =====================================================================

        // Check if user would see selector (fresh dir, no bypass flags)
        const wouldShowSelector =
          !localSettings.lastAgent && !forceNew && !agentIdArg && !fromAfFile;

        if (
          wouldShowSelector &&
          globalPinned.length === 0 &&
          !needsModelPicker
        ) {
          // New user with no pinned agents - create a fresh Memo agent
          // NOTE: Always creates a new agent (no server-side tag lookup) to avoid
          // picking up agents created by other users on shared orgs.
          // Skip if needsModelPicker is true - let user select a model first.
          const { ensureDefaultAgents } = await import("./agent/defaults");
          try {
            const memoAgent = await ensureDefaultAgents(client);
            if (memoAgent) {
              setSelectedGlobalAgentId(memoAgent.id);
              setLoadingState("assembling");
              return;
            }
            // If memoAgent is null (createDefaultAgents disabled), fall through
          } catch (err) {
            console.error(
              `Failed to create default agents: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          }
        }

        // If there's a local LRU, use it directly (takes priority over model picker)
        if (localSettings.lastAgent) {
          try {
            await client.agents.retrieve(localSettings.lastAgent);
            setLoadingState("assembling");
            return;
          } catch {
            // LRU agent doesn't exist, show message and fall through to selector
            setFailedAgentMessage(
              `Unable to locate recently used agent ${localSettings.lastAgent}`,
            );
          }
        }

        // On self-hosted with unavailable default model, show selector to pick a model
        if (needsModelPicker) {
          setLoadingState("selecting_global");
          return;
        }

        // Show selector if there are pinned agents to choose from
        if (wouldShowSelector && globalPinned.length > 0) {
          setLoadingState("selecting_global");
          return;
        }

        setLoadingState("assembling");
      }
      checkAndStart();
    }, [
      forceNew,
      agentIdArg,
      fromAfFile,
      continueSession,
      shouldResume,
      specifiedConversationId,
    ]);

    // Main initialization effect - runs after profile selection
    useEffect(() => {
      if (loadingState !== "assembling") return;

      async function init() {
        const client = await getClient();

        // Determine which agent we'll be using (before loading tools)
        let resumingAgentId: string | null = null;

        // Priority 1: --agent flag
        if (agentIdArg) {
          try {
            await client.agents.retrieve(agentIdArg);
            resumingAgentId = agentIdArg;
          } catch {
            // Agent doesn't exist, will create new later
          }
        }

        // Priority 1.5: Use agent from conversation selector (--resume flag)
        if (!resumingAgentId && resumeAgentId) {
          resumingAgentId = resumeAgentId;
        }

        // Priority 2: Use agent selected from global selector (user just picked one)
        // This takes precedence over stale LRU since user explicitly chose it
        const shouldCreateNew = forceNew || userRequestedNewAgent;
        if (!resumingAgentId && !shouldCreateNew && selectedGlobalAgentId) {
          try {
            await client.agents.retrieve(selectedGlobalAgentId);
            resumingAgentId = selectedGlobalAgentId;
          } catch {
            // Selected agent doesn't exist - show selector again
            setLoadingState("selecting_global");
            return;
          }
        }

        // Priority 3: LRU from local settings (if not --new or user explicitly requested new from selector)
        if (!resumingAgentId && !shouldCreateNew) {
          const localProjectSettings =
            settingsManager.getLocalProjectSettings();
          if (localProjectSettings?.lastAgent) {
            try {
              await client.agents.retrieve(localProjectSettings.lastAgent);
              resumingAgentId = localProjectSettings.lastAgent;
            } catch {
              // LRU agent doesn't exist (wrong org, deleted, etc.)
              // Show selector instead of silently creating a new agent
              setLoadingState("selecting_global");
              return;
            }
          }

          // Priority 4: Try global settings if --continue flag
          if (!resumingAgentId && continueSession && settings.lastAgent) {
            try {
              await client.agents.retrieve(settings.lastAgent);
              resumingAgentId = settings.lastAgent;
            } catch {
              // Global agent doesn't exist - show selector
              setLoadingState("selecting_global");
              return;
            }
          }
        }

        // Set resuming state early so loading messages are accurate
        setIsResumingSession(!!resumingAgentId);

        // Load toolset: use explicit --toolset flag if provided, otherwise derive from model
        // NOTE: We don't persist toolset per-agent. On resume, toolset is re-derived from model.
        // If explicit toolset overrides need to persist, see comment in tools/toolset.ts
        const modelForTools = getModelForToolLoading(
          model,
          toolset as "codex" | "default" | undefined,
        );
        await loadTools(modelForTools);

        setLoadingState("initializing");
        const { createAgent } = await import("./agent/create");
        const { getModelUpdateArgs } = await import("./agent/model");

        let agent: AgentState | null = null;
        let isNewlyCreatedAgent = false;

        // Priority 1: Import from AgentFile template
        if (fromAfFile) {
          setLoadingState("importing");
          const { importAgentFromFile } = await import("./agent/import");
          const result = await importAgentFromFile({
            filePath: fromAfFile,
            modelOverride: model,
            stripMessages: true,
          });
          agent = result.agent;
          isNewlyCreatedAgent = true;
          setAgentProvenance({
            isNew: true,
            blocks: [],
          });
        }

        // Priority 2: Try to use --agent specified ID
        if (!agent && agentIdArg) {
          try {
            agent = await client.agents.retrieve(agentIdArg);

            // Apply --system flag to existing agent if provided
            if (systemPromptPreset) {
              const { updateAgentSystemPrompt } = await import(
                "./agent/modify"
              );
              const result = await updateAgentSystemPrompt(
                agent.id,
                systemPromptPreset,
              );
              if (!result.success || !result.agent) {
                console.error(
                  `Failed to update system prompt: ${result.message}`,
                );
                process.exit(1);
              }
              agent = result.agent;
            }
          } catch (error) {
            console.error(
              `Agent ${agentIdArg} not found (error: ${JSON.stringify(error)})`,
            );
            console.error(
              "When using --agent, the specified agent ID must exist.",
            );
            console.error("Run 'letta' without --agent to create a new agent.");
            process.exit(1);
          }
        }

        // Priority 3: Check if --new flag was passed or user requested new from selector
        if (!agent && shouldCreateNew) {
          // For self-hosted: if default model unavailable and no model selected yet, show picker
          if (availableServerModels.length > 0 && !selectedServerModel) {
            setLoadingState("selecting_global");
            return;
          }

          // Determine effective model:
          // 1. Use selectedServerModel if user picked from self-hosted picker
          // 2. Use model if --model flag was passed
          // 3. Otherwise, use billing-tier-aware default (free tier gets glm-4.7)
          let effectiveModel = selectedServerModel || model;
          if (!effectiveModel && !selfHostedBaseUrl) {
            // On Letta API without explicit model - check billing tier for appropriate default
            const { getDefaultModelForTier } = await import("./agent/model");
            let billingTier: string | null = null;
            try {
              const baseURL =
                process.env.LETTA_BASE_URL ||
                settings.env?.LETTA_BASE_URL ||
                LETTA_CLOUD_API_URL;
              const apiKey =
                process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
              const response = await fetch(`${baseURL}/v1/metadata/balance`, {
                headers: getLettaCodeHeaders(apiKey),
              });
              if (response.ok) {
                const data = (await response.json()) as {
                  billing_tier?: string;
                };
                billingTier = data.billing_tier ?? null;
              }
            } catch {
              // Ignore - will use standard default
            }
            effectiveModel = getDefaultModelForTier(billingTier);
          }

          const updateArgs = getModelUpdateArgs(effectiveModel);
          const result = await createAgent(
            undefined,
            effectiveModel,
            undefined,
            updateArgs,
            skillsDirectory,
            true, // parallelToolCalls always enabled
            sleeptimeFlag ?? settings.enableSleeptime,
            systemPromptPreset,
            initBlocks,
            baseTools,
          );
          agent = result.agent;
          isNewlyCreatedAgent = true;
          setAgentProvenance(result.provenance);
        }

        // Priority 4: Try to resume from project settings LRU (.letta/settings.local.json)
        // Note: If LRU retrieval failed in early validation, we already showed selector and returned
        // This block handles the case where we have a valid resumingAgentId from early validation
        if (!agent && resumingAgentId) {
          try {
            agent = await client.agents.retrieve(resumingAgentId);
          } catch (error) {
            // Agent disappeared between validation and now - show selector
            console.error(
              `Agent ${resumingAgentId} not found (error: ${JSON.stringify(error)})`,
            );
            setLoadingState("selecting_global");
            return;
          }
        }

        // Priority 6: Try to reuse global lastAgent if --continue flag is passed
        // Note: If global lastAgent retrieval failed in early validation (with --continue),
        // we already showed selector and returned. This is a safety fallback.
        if (!agent && continueSession && settings.lastAgent) {
          try {
            agent = await client.agents.retrieve(settings.lastAgent);
          } catch (error) {
            // Agent disappeared - show selector instead of silently creating
            console.error(
              `Previous agent ${settings.lastAgent} not found (error: ${JSON.stringify(error)})`,
            );
            setLoadingState("selecting_global");
            return;
          }
        }

        // All paths should have resolved to an agent by now
        // If not, it's an unexpected state - error out instead of auto-creating
        if (!agent) {
          console.error(
            "No agent found. Use --new-agent to create a new agent.",
          );
          process.exit(1);
        }

        // Ensure local project settings are loaded before updating
        // (they may not have been loaded if we didn't try to resume from project settings)
        try {
          settingsManager.getLocalProjectSettings();
        } catch {
          await settingsManager.loadLocalProjectSettings();
        }

        // Save agent ID to both project and global settings
        settingsManager.updateLocalProjectSettings({ lastAgent: agent.id });
        settingsManager.updateSettings({ lastAgent: agent.id });

        // Ensure the agent has the required skills blocks (for backwards compatibility)
        const createdBlocks = await ensureSkillsBlocks(agent.id);
        if (createdBlocks.length > 0) {
          console.log("Created missing skills blocks for agent compatibility");
        }

        // Set agent context for tools that need it (e.g., Skill tool)
        setAgentContext(agent.id, skillsDirectory);

        // Apply memfs flag if specified, or enable by default for new agents
        const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
        if (memfsFlag) {
          settingsManager.setMemfsEnabled(agent.id, true);
        } else if (noMemfsFlag) {
          settingsManager.setMemfsEnabled(agent.id, false);
        } else if (isNewlyCreatedAgent && !isSubagent) {
          // Enable memfs by default for newly created agents (but not subagents)
          settingsManager.setMemfsEnabled(agent.id, true);
        }

        // Fire-and-forget: Initialize loaded skills flag (LET-7101)
        // Don't await - this is just for the skill unload reminder
        initializeLoadedSkillsFlag().catch(() => {
          // Ignore errors - not critical
        });

        // Fire-and-forget: Sync skills in background (LET-7101)
        // This ensures new skills added after agent creation are available
        // Don't await - user can start typing immediately
        (async () => {
          try {
            const { syncSkillsToAgent, SKILLS_DIR } = await import(
              "./agent/skills"
            );
            const { join } = await import("node:path");

            const resolvedSkillsDirectory =
              skillsDirectory || join(process.cwd(), SKILLS_DIR);

            await syncSkillsToAgent(client, agent.id, resolvedSkillsDirectory, {
              skipIfUnchanged: true,
            });
          } catch (error) {
            console.warn(
              `[skills] Background sync failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();

        // Check if we're resuming an existing agent
        // We're resuming if:
        // 1. We specified an agent ID via --agent flag (agentIdArg)
        // 2. We used --resume flag (continueSession)
        // 3. We're reusing a project agent (detected early as resumingAgentId)
        // 4. We retrieved an agent from LRU (detected by checking if agent already existed)
        const isResumingProject = !shouldCreateNew && !!resumingAgentId;
        const isReusingExistingAgent =
          !shouldCreateNew && !fromAfFile && agent && agent.id;
        const resuming = !!(
          continueSession ||
          agentIdArg ||
          isResumingProject ||
          isReusingExistingAgent
        );
        setIsResumingSession(resuming);

        // If resuming and a model or system prompt was specified, apply those changes
        if (resuming && (model || systemPromptPreset)) {
          if (model) {
            const { resolveModel, getModelUpdateArgs } = await import(
              "./agent/model"
            );
            const modelHandle = resolveModel(model);
            if (!modelHandle) {
              console.error(`Error: Invalid model "${model}"`);
              process.exit(1);
            }

            // Always apply model update - different model IDs can share the same
            // handle but have different settings (e.g., gpt-5.2-medium vs gpt-5.2-xhigh)
            const { updateAgentLLMConfig } = await import("./agent/modify");
            const updateArgs = getModelUpdateArgs(model);
            await updateAgentLLMConfig(agent.id, modelHandle, updateArgs);
            // Refresh agent state after model update
            agent = await client.agents.retrieve(agent.id);
          }

          if (systemPromptPreset) {
            const { updateAgentSystemPrompt } = await import("./agent/modify");
            const result = await updateAgentSystemPrompt(
              agent.id,
              systemPromptPreset,
            );
            if (!result.success || !result.agent) {
              console.error(`Error: ${result.message}`);
              process.exit(1);
            }
            agent = result.agent;
          }
        }

        // Handle conversation: either resume existing or create new
        // Using definite assignment assertion - all branches below either set this or exit/throw
        let conversationIdToUse!: string;

        // Debug: log resume flag status
        if (process.env.DEBUG) {
          console.log(`[DEBUG] shouldContinue=${shouldContinue}`);
          console.log(`[DEBUG] shouldResume=${shouldResume}`);
          console.log(
            `[DEBUG] specifiedConversationId=${specifiedConversationId}`,
          );
        }

        if (specifiedConversationId) {
          // Use the explicitly specified conversation ID
          // User explicitly requested this conversation, so error if it doesn't exist
          conversationIdToUse = specifiedConversationId;
          setResumedExistingConversation(true);
          try {
            // Load message history and pending approvals from the conversation
            // Re-fetch agent to get fresh message_ids for accurate pending approval detection
            setLoadingState("checking");
            const freshAgent = await client.agents.retrieve(agent.id);
            const data = await getResumeData(
              client,
              freshAgent,
              specifiedConversationId,
            );
            setResumeData(data);
          } catch (error) {
            // Only treat 404/422 as "not found", rethrow other errors
            if (
              error instanceof APIError &&
              (error.status === 404 || error.status === 422)
            ) {
              console.error(
                `Conversation ${specifiedConversationId} not found`,
              );
              process.exit(1);
            }
            throw error;
          }
        } else if (shouldContinue) {
          // Try to load the last session for this agent
          const lastSession =
            settingsManager.getLocalLastSession(process.cwd()) ??
            settingsManager.getGlobalLastSession();

          if (process.env.DEBUG) {
            console.log(`[DEBUG] lastSession=${JSON.stringify(lastSession)}`);
            console.log(`[DEBUG] agent.id=${agent.id}`);
          }

          let resumedSuccessfully = false;
          if (lastSession && lastSession.agentId === agent.id) {
            // Try to resume the exact last conversation
            // If it no longer exists, fall back to creating new
            try {
              // Load message history and pending approvals from the conversation
              // Re-fetch agent to get fresh message_ids for accurate pending approval detection
              setLoadingState("checking");
              const freshAgent = await client.agents.retrieve(agent.id);
              const data = await getResumeData(
                client,
                freshAgent,
                lastSession.conversationId,
              );
              // Only set state after validation succeeds
              conversationIdToUse = lastSession.conversationId;
              setResumedExistingConversation(true);
              setResumeData(data);
              resumedSuccessfully = true;
            } catch (error) {
              // Only treat 404/422 as "not found", rethrow other errors
              if (
                error instanceof APIError &&
                (error.status === 404 || error.status === 422)
              ) {
                // Conversation no longer exists, will create new below
                console.warn(
                  `Previous conversation ${lastSession.conversationId} not found, creating new`,
                );
              } else {
                throw error;
              }
            }
          }

          if (!resumedSuccessfully) {
            // No valid session to resume - error with helpful message
            console.error(
              `Attempting to resume conversation ${lastSession?.conversationId ?? "(unknown)"}, but conversation was not found.`,
            );
            console.error(
              "Resume the default conversation with 'letta', view recent conversations with 'letta --resume', or start a new conversation with 'letta --new'.",
            );
            process.exit(1);
          }
        } else if (selectedConversationId) {
          // User selected a specific conversation from the --resume selector
          try {
            setLoadingState("checking");
            const freshAgent = await client.agents.retrieve(agent.id);
            const data = await getResumeData(
              client,
              freshAgent,
              selectedConversationId,
            );
            conversationIdToUse = selectedConversationId;
            setResumedExistingConversation(true);
            setResumeData(data);
          } catch (error) {
            if (
              error instanceof APIError &&
              (error.status === 404 || error.status === 422)
            ) {
              console.error(`Conversation ${selectedConversationId} not found`);
              process.exit(1);
            }
            throw error;
          }
        } else if (forceNewConversation) {
          // --new flag: create a new conversation (for concurrent sessions)
          const conversation = await client.conversations.create({
            agent_id: agent.id,
            isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
          });
          conversationIdToUse = conversation.id;
        } else {
          // Default (including --new-agent): use the agent's "default" conversation
          conversationIdToUse = "default";

          // Load message history from the default conversation
          setLoadingState("checking");
          const freshAgent = await client.agents.retrieve(agent.id);
          const data = await getResumeData(client, freshAgent, "default");
          setResumeData(data);
          setResumedExistingConversation(true);
        }

        // Save the session (agent + conversation) to settings
        // Skip for subagents - they shouldn't pollute the LRU settings
        if (!isSubagent) {
          settingsManager.setLocalLastSession(
            { agentId: agent.id, conversationId: conversationIdToUse },
            process.cwd(),
          );
          settingsManager.setGlobalLastSession({
            agentId: agent.id,
            conversationId: conversationIdToUse,
          });
        }

        setAgentId(agent.id);
        setAgentState(agent);
        setConversationId(conversationIdToUse);
        // Also set in global context for tools (e.g., Skill tool) to access
        setContextConversationId(conversationIdToUse);
        setLoadingState("ready");
      }

      init().catch((err) => {
        // Handle errors gracefully without showing raw stack traces
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred";
        console.error(`\nError during initialization: ${message}`);
        if (process.env.DEBUG) {
          console.error(err);
        }
        process.exit(1);
      });
    }, [
      continueSession,
      forceNew,
      userRequestedNewAgent,
      agentIdArg,
      model,
      systemPromptPreset,
      fromAfFile,
      loadingState,
      selectedGlobalAgentId,
      shouldContinue,
      resumeAgentId,
      selectedConversationId,
    ]);

    // Wait for keybinding auto-install to complete before showing UI
    if (showKeybindingSetup === null) {
      return null;
    }

    // During initial "selecting" phase, render ProfileSelectionInline with loading state
    // to prevent component tree switch whitespace artifacts
    if (loadingState === "selecting") {
      return React.createElement(ProfileSelectionInline, {
        lruAgentId: null,
        loading: true, // Show loading state while checking
        freshRepoMode: true,
        onSelect: () => {},
        onCreateNew: () => {},
        onExit: () => process.exit(0),
      });
    }

    // Show conversation selector for --resume flag
    if (loadingState === "selecting_conversation" && resumeAgentId) {
      return React.createElement(ConversationSelector, {
        agentId: resumeAgentId,
        agentName: resumeAgentName ?? undefined,
        currentConversationId: "", // No current conversation yet
        onSelect: (conversationId: string) => {
          setSelectedConversationId(conversationId);
          setLoadingState("assembling");
        },
        onNewConversation: () => {
          // Start with a new conversation for this agent
          setLoadingState("assembling");
        },
        onCancel: () => {
          process.exit(0);
        },
      });
    }

    // Show global agent selector in fresh repos with global pinned agents
    if (loadingState === "selecting_global") {
      return React.createElement(ProfileSelectionInline, {
        lruAgentId: null, // No LRU in fresh repo
        loading: false,
        freshRepoMode: true, // Hides "(global)" labels and simplifies context message
        failedAgentMessage: failedAgentMessage ?? undefined,
        // For self-hosted: pass available models so user can pick one when creating new agent
        serverModelsForNewAgent:
          availableServerModels.length > 0 ? availableServerModels : undefined,
        defaultModelHandle: selfHostedDefaultModel ?? undefined,
        serverBaseUrl: selfHostedBaseUrl ?? undefined,
        onSelect: (agentId: string) => {
          setSelectedGlobalAgentId(agentId);
          setLoadingState("assembling");
        },
        onCreateNew: () => {
          setUserRequestedNewAgent(true);
          setLoadingState("assembling");
        },
        onCreateNewWithModel: (modelHandle: string) => {
          setUserRequestedNewAgent(true);
          setSelectedServerModel(modelHandle);
          setLoadingState("assembling");
        },
        onExit: () => {
          process.exit(0);
        },
      });
    }

    // At this point, loadingState is not "selecting", "selecting_global", or "selecting_conversation"
    // (those are handled above), so it's safe to pass to App
    const appLoadingState = loadingState as Exclude<
      typeof loadingState,
      "selecting" | "selecting_global" | "selecting_conversation"
    >;

    if (!agentId || !conversationId) {
      return React.createElement(App, {
        agentId: "loading",
        conversationId: "loading",
        loadingState: appLoadingState,
        continueSession: isResumingSession,
        startupApproval: resumeData?.pendingApproval ?? null,
        startupApprovals: resumeData?.pendingApprovals ?? EMPTY_APPROVAL_ARRAY,
        messageHistory: resumeData?.messageHistory ?? EMPTY_MESSAGE_ARRAY,
        resumedExistingConversation,
        tokenStreaming: settings.tokenStreaming,
        agentProvenance,
        releaseNotes,
      });
    }

    return React.createElement(App, {
      agentId,
      agentState,
      conversationId,
      loadingState: appLoadingState,
      continueSession: isResumingSession,
      startupApproval: resumeData?.pendingApproval ?? null,
      startupApprovals: resumeData?.pendingApprovals ?? EMPTY_APPROVAL_ARRAY,
      messageHistory: resumeData?.messageHistory ?? EMPTY_MESSAGE_ARRAY,
      resumedExistingConversation,
      tokenStreaming: settings.tokenStreaming,
      agentProvenance,
      releaseNotes,
    });
  }

  markMilestone("REACT_RENDER_START");
  render(
    React.createElement(LoadingApp, {
      continueSession: shouldContinue,
      forceNew: forceNew,
      initBlocks: initBlocks,
      baseTools: baseTools,
      agentIdArg: specifiedAgentId,
      model: specifiedModel,
      systemPromptPreset: systemPromptPreset,
      toolset: specifiedToolset as "codex" | "default" | "gemini" | undefined,
      skillsDirectory: skillsDirectory,
      fromAfFile: fromAfFile,
    }),
    {
      exitOnCtrlC: false, // We handle CTRL-C manually with double-press guard
    },
  );
}

main();
