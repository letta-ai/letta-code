#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeData, type ResumeData } from "./agent/check-approval";
import { getClient } from "./agent/client";
import { initializeLoadedSkillsFlag, setAgentContext } from "./agent/context";
import type { AgentProvenance } from "./agent/create";
import { LETTA_CLOUD_API_URL } from "./auth/oauth";
import type { ApprovalRequest } from "./cli/helpers/stream";
import { ProfileSelectionInline } from "./cli/profile-selection";
import { permissionMode } from "./permissions/mode";
import { settingsManager } from "./settings-manager";
import { telemetry } from "./telemetry";
import { loadTools } from "./tools/manager";

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
  letta                 Resume from profile or create new agent (shows selector)
  letta --new           Create a new agent directly (skip profile selector)
  letta --agent <id>    Open a specific agent by ID

  # headless
  letta -p "..."        One-off prompt in headless mode (no TTY UI)

  # maintenance
  letta update          Manually check for updates and install if available

OPTIONS
  -h, --help            Show this help and exit
  -v, --version         Print version and exit
  --info                Show current directory, skills, and pinned agents
  --new                 Create new agent directly (skip profile selection)
  --init-blocks <list>  Comma-separated memory blocks to initialize when using --new (e.g., "persona,skills")
  --base-tools <list>   Comma-separated base tools to attach when using --new (e.g., "memory,web_search,conversation_search")
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
  --skills <path>       Custom path to skills directory (default: .skills in current directory)
  --sleeptime           Enable sleeptime memory management (only for new agents)
  --from-af <path>      Create agent from an AgentFile (.af) template

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
  letta --new              # Create new agent directly
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
  // Initialize settings manager (loads settings once into memory)
  await settingsManager.initialize();
  const settings = await settingsManager.getSettingsWithSecureTokens();

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
  checkAndAutoUpdate().catch(() => {
    // Silently ignore update failures
  });

  // Parse command-line arguments (Bun-idiomatic approach using parseArgs)
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        info: { type: "boolean" },
        continue: { type: "boolean", short: "c" },
        new: { type: "boolean" },
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
        skills: { type: "string" },
        sleeptime: { type: "boolean" },
        "from-af": { type: "string" },
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

  const shouldContinue = (values.continue as boolean | undefined) ?? false;
  const forceNew = (values.new as boolean | undefined) ?? false;
  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  let specifiedAgentId = (values.agent as string | undefined) ?? null;
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
    if (shouldContinue) {
      console.error("Error: --from-af cannot be used with --continue");
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
    // For headless mode, load tools synchronously (respecting model/toolset when provided)
    const modelForTools = getModelForToolLoading(
      specifiedModel,
      specifiedToolset as "codex" | "default" | undefined,
    );
    await loadTools(modelForTools);

    const { handleHeadlessCommand } = await import("./headless");
    await handleHeadlessCommand(process.argv, specifiedModel, skillsDirectory);
    return;
  }

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
      | "assembling"
      | "importing"
      | "initializing"
      | "checking"
      | "ready"
    >("selecting");
    const [agentId, setAgentId] = useState<string | null>(null);
    const [agentState, setAgentState] = useState<AgentState | null>(null);
    const [resumeData, setResumeData] = useState<ResumeData | null>(null);
    const [isResumingSession, setIsResumingSession] = useState(false);
    const [agentProvenance, setAgentProvenance] =
      useState<AgentProvenance | null>(null);
    const [selectedGlobalAgentId, setSelectedGlobalAgentId] = useState<
      string | null
    >(null);
    // Track when user explicitly requested new agent from selector (not via --new flag)
    const [userRequestedNewAgent, setUserRequestedNewAgent] = useState(false);

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

    // Initialize on mount - check if we should show global agent selector
    useEffect(() => {
      async function checkAndStart() {
        // Load settings
        await settingsManager.loadLocalProjectSettings();
        const localSettings = settingsManager.getLocalProjectSettings();
        const globalPinned = settingsManager.getGlobalPinnedAgents();

        // Show selector if:
        // 1. No lastAgent in this project (fresh directory)
        // 2. No explicit flags that bypass selection (--new, --agent, --from-af, --continue)
        // 3. Has global pinned agents available
        const shouldShowSelector =
          !localSettings.lastAgent &&
          !forceNew &&
          !agentIdArg &&
          !fromAfFile &&
          !continueSession &&
          globalPinned.length > 0;

        if (shouldShowSelector) {
          setLoadingState("selecting_global");
          return;
        }

        setLoadingState("assembling");
      }
      checkAndStart();
    }, [forceNew, agentIdArg, fromAfFile, continueSession]);

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

        // Priority 2: LRU from local settings (if not --new or user explicitly requested new from selector)
        const shouldCreateNew = forceNew || userRequestedNewAgent;
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

          // Priority 3: Try global settings if --continue flag
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

          // Priority 4: Use agent selected from global selector
          if (!resumingAgentId && selectedGlobalAgentId) {
            try {
              await client.agents.retrieve(selectedGlobalAgentId);
              resumingAgentId = selectedGlobalAgentId;
            } catch {
              // Agent doesn't exist, will create new
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
          const updateArgs = getModelUpdateArgs(model);
          const result = await createAgent(
            undefined,
            model,
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

        // Priority 7: Create a new agent
        if (!agent) {
          const updateArgs = getModelUpdateArgs(model);
          const result = await createAgent(
            undefined,
            model,
            undefined,
            updateArgs,
            skillsDirectory,
            true, // parallelToolCalls always enabled
            sleeptimeFlag ?? settings.enableSleeptime,
            systemPromptPreset,
            undefined,
            undefined,
          );
          agent = result.agent;
          setAgentProvenance(result.provenance);
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

        // Set agent context for tools that need it (e.g., Skill tool)
        setAgentContext(agent.id, skillsDirectory);
        await initializeLoadedSkillsFlag();

        // Re-discover skills and update the skills memory block
        // This ensures new skills added after agent creation are available
        try {
          const { discoverSkills, formatSkillsForMemory, SKILLS_DIR } =
            await import("./agent/skills");
          const { join } = await import("node:path");

          const resolvedSkillsDirectory =
            skillsDirectory || join(process.cwd(), SKILLS_DIR);
          const { skills, errors } = await discoverSkills(
            resolvedSkillsDirectory,
          );

          if (errors.length > 0) {
            console.warn("Errors encountered during skill discovery:");
            for (const error of errors) {
              console.warn(`  ${error.path}: ${error.message}`);
            }
          }

          // Update the skills memory block with freshly discovered skills
          const formattedSkills = formatSkillsForMemory(
            skills,
            resolvedSkillsDirectory,
          );
          await client.agents.blocks.update("skills", {
            agent_id: agent.id,
            value: formattedSkills,
          });
        } catch (error) {
          console.warn(
            `Failed to update skills: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Check if we're resuming an existing agent
        // We're resuming if:
        // 1. We specified an agent ID via --agent flag (agentIdArg)
        // 2. We used --continue flag (continueSession)
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
            const { resolveModel } = await import("./agent/model");
            const modelHandle = resolveModel(model);
            if (!modelHandle) {
              console.error(`Error: Invalid model "${model}"`);
              process.exit(1);
            }

            // Optimization: Skip update if agent is already using the specified model
            const currentModel = agent.llm_config?.model;
            const currentEndpointType = agent.llm_config?.model_endpoint_type;
            const currentHandle = `${currentEndpointType}/${currentModel}`;

            if (currentHandle !== modelHandle) {
              const { updateAgentLLMConfig } = await import("./agent/modify");
              const { getModelUpdateArgs } = await import("./agent/model");
              const updateArgs = getModelUpdateArgs(model);
              await updateAgentLLMConfig(agent.id, modelHandle, updateArgs);
              // Refresh agent state after model update
              agent = await client.agents.retrieve(agent.id);
            }
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

        // Get resume data (pending approval + message history) if resuming
        if (resuming) {
          setLoadingState("checking");
          const data = await getResumeData(client, agent);
          setResumeData(data);
        }

        setAgentId(agent.id);
        setAgentState(agent);
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
    ]);

    // Wait for keybinding auto-install to complete before showing UI
    if (showKeybindingSetup === null) {
      return null;
    }

    // Don't render anything during initial "selecting" phase - wait for checkAndStart
    if (loadingState === "selecting") {
      return null;
    }

    // Show global agent selector in fresh repos with global pinned agents
    if (loadingState === "selecting_global") {
      return React.createElement(ProfileSelectionInline, {
        lruAgentId: null, // No LRU in fresh repo
        loading: false,
        freshRepoMode: true, // Hides "(global)" labels and simplifies context message
        onSelect: (agentId: string) => {
          // Auto-pin the selected global agent to this project
          settingsManager.pinLocal(agentId);

          setSelectedGlobalAgentId(agentId);
          setLoadingState("assembling");
        },
        onCreateNew: () => {
          setUserRequestedNewAgent(true);
          setLoadingState("assembling");
        },
        onExit: () => {
          process.exit(0);
        },
      });
    }

    if (!agentId) {
      return React.createElement(App, {
        agentId: "loading",
        loadingState,
        continueSession: isResumingSession,
        startupApproval: resumeData?.pendingApproval ?? null,
        startupApprovals: resumeData?.pendingApprovals ?? EMPTY_APPROVAL_ARRAY,
        messageHistory: resumeData?.messageHistory ?? EMPTY_MESSAGE_ARRAY,
        tokenStreaming: settings.tokenStreaming,
        agentProvenance,
      });
    }

    return React.createElement(App, {
      agentId,
      agentState,
      loadingState,
      continueSession: isResumingSession,
      startupApproval: resumeData?.pendingApproval ?? null,
      startupApprovals: resumeData?.pendingApprovals ?? EMPTY_APPROVAL_ARRAY,
      messageHistory: resumeData?.messageHistory ?? EMPTY_MESSAGE_ARRAY,
      tokenStreaming: settings.tokenStreaming,
      agentProvenance,
    });
  }

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
