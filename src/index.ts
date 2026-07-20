#!/usr/bin/env bun
import { hostname } from "node:os";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { getTerminalTelemetrySurface, telemetry } from "@/telemetry";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  getResumeDataFromBackend,
  type ResumeData,
} from "./agent/check-approval";
import {
  setAgentContext,
  setConversationId as setContextConversationId,
} from "./agent/context";
import type { AgentProvenance } from "./agent/create";
import {
  getModelPresetUpdateForAgent,
  getModelUpdateArgs,
  getResumeRefreshArgs,
  type ModelReasoningEffort,
  preservableContextWindow,
  resolveModel,
} from "./agent/model";
import { updateAgentLLMConfig, updateAgentSystemPrompt } from "./agent/modify";
import { buildCreateAgentOptionsForPersonality } from "./agent/personality";
import { resolvePersonalityId } from "./agent/personality-presets";
import type { MemoryPromptMode } from "./agent/prompt-assets";
import { resolveSkillSourcesSelection } from "./agent/skill-sources";
import { LETTA_CLOUD_API_URL, refreshAccessToken } from "./auth/oauth";
import {
  type Backend,
  type BackendMode,
  configureBackendMode,
  getBackend,
  getBackendForMode,
  isExperimentalLocalBackendEnabled,
} from "./backend";
import { getBillingTier } from "./backend/api/metadata";
import { LOCAL_BACKEND_EXPERIMENTAL_ENV } from "./backend/local/paths";
import {
  extractBackendFlag,
  type ParsedCliArgs,
  parseCliArgs,
  preprocessCliArgs,
  renderCliOptionsHelp,
} from "./cli/args";
import { ConversationSelector } from "./cli/components/ConversationSelector";
import {
  normalizeConversationShorthandFlags,
  parseCsvListFlag,
  resolveImportFlagAlias,
} from "./cli/flag-utils";
import { LETTA_CHAT_API_KEYS_URL } from "./cli/helpers/app-urls";
import { formatErrorDetails } from "./cli/helpers/error-formatter";
import { ensureFdPath, resolveFdPath } from "./cli/helpers/file-autocomplete";
import { listPinnedAgentsForCurrentUser } from "./cli/helpers/pinned-agent-listing";
import type { ApprovalRequest } from "./cli/helpers/stream";
import { initTerminalTheme } from "./cli/helpers/terminal-theme";
import { ProfileSelectionInline } from "./cli/profile-selection";
import {
  getStartupBackendLookupOrder,
  inferBackendModeFromAgentId,
  resolveSubcommandBackendMode,
} from "./cli/startup-backend-mode";
import {
  validateConversationDefaultRequiresAgent,
  validateFlagConflicts,
  validateRegistryHandleOrThrow,
} from "./cli/startup-flag-validation";
import {
  runSubcommand,
  subcommandNeedsEarlyBackendMode,
} from "./cli/subcommands/router";
import { disableModsForProcess, shouldDisableMods } from "./mods/disable";
import { applyStartupPermissionMode } from "./permissions/startup";
import {
  type Settings,
  settingsManager,
  shouldPersistSessionState,
} from "./settings-manager";
import { startStartupAutoUpdateCheck } from "./startup-auto-update";
import { loadTools } from "./tools/manager";
import { clearPersistedClientToolRules } from "./tools/toolset";
import { debugLog, debugWarn, isDebugEnabled } from "./utils/debug";
import { startOrphanDetection } from "./utils/orphan-detection";
import { markMilestone } from "./utils/timing";

// Stable empty array constants to prevent new references on every render
// These are used as fallbacks when resumeData is null, avoiding the React
// anti-pattern of creating new [] on every render which triggers useEffect re-runs
const EMPTY_APPROVAL_ARRAY: ApprovalRequest[] = [];
const EMPTY_MESSAGE_ARRAY: Message[] = [];

function normalizeUpdateCommandAliases(args: string[]): string[] {
  const [command, ...rest] = args;

  if (
    command === "upgrade" ||
    command === "--update" ||
    command === "--upgrade"
  ) {
    return ["update", ...rest];
  }

  return args;
}

function trackCliBoundaryError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

async function refreshStartupOAuthToken(
  settings: Settings,
): Promise<string | null> {
  if (!settings.refreshToken) {
    return null;
  }

  try {
    const now = Date.now();
    const deviceId = settingsManager.getOrCreateDeviceId();
    const deviceName = hostname();
    const tokens = await refreshAccessToken(
      settings.refreshToken,
      deviceId,
      deviceName,
    );

    settingsManager.updateSettings({
      env: { LETTA_API_KEY: tokens.access_token },
      refreshToken: tokens.refresh_token || settings.refreshToken,
      tokenExpiresAt: now + tokens.expires_in * 1000,
    });
    await settingsManager.flush();

    return tokens.access_token;
  } catch (error) {
    trackCliBoundaryError(
      "startup_auth_token_refresh_failed",
      error,
      "startup_auth_token_refresh",
    );
    debugWarn("auth", "Failed to refresh OAuth token during startup", error);
    return null;
  }
}

function printHelp() {
  // Keep this plaintext (no colors) so output pipes cleanly
  const usage = `
Letta Code is a general purpose CLI for interacting with Letta agents

USAGE
  # interactive TUI
  letta                 Resume last conversation for this project
  letta --new           Create a new conversation (for concurrent sessions)
  letta --resume        Open agent selector UI to pick agent/conversation
  letta --new-agent     Create a new agent directly (skip profile selector)
  letta --agent <id>    Open a specific agent by ID

  # headless
  letta -p "..."        One-off prompt in headless mode (no TTY UI)

  # maintenance
  letta update          Manually check for updates and install if available
  letta upgrade         Alias for \`letta update\`
  letta --update        Alias for \`letta update\`
  letta --upgrade       Alias for \`letta update\`
  letta memory ...      Memory filesystem subcommands
  letta agents ...      Agents subcommands (JSON-only)
  letta environments ... List available remote environments (JSON-only)
  letta messages ...    Messages subcommands (JSON-only)
  letta mods ...        List and manage local mods
  letta server ...      Run a remote environment, channels, or the App Server
  letta connect ...     Connect providers from terminal
  letta backend ...     Show or set the default backend
  letta setup           Re-run first-run setup
  letta install ...     Install a skill or mod package
  letta skills ...      List or delete installed agent skills

OPTIONS
${renderCliOptionsHelp()}

SUBCOMMANDS
  letta memory status --agent <id>
  letta memory diff --agent <id>
  letta memory resolve --agent <id> --resolutions '<JSON>'
  letta memory backup --agent <id>
  letta memory backups --agent <id>
  letta memory restore --agent <id> --from <backup> --force
  letta memory export --agent <id> --out <dir>
  letta memory pull --agent <id>
  letta memory tokens [--memory-dir <path>] [--agent <id>] [--format text|json]
  letta agents list [--query <text> | --name <name> | --tags <tags>]
  letta environments list [--online-only]
  letta environments current
  letta messages search --query <text> [--all-agents]
  letta messages list [--agent <id>]
  letta messages transcript --conversation <id> [--out <path>]
  letta mods list [--agent <id>]
  letta mods package <mod-file> --name <package-name> [--out <dir>]
  letta mods enable <package-spec>
  letta mods disable <package-spec>
  letta mods remove <package-spec>
  letta server [--env-name <name> | --listen [url]] [options]
  letta connect <provider> [options]
  letta install <thing> [--agent <id> | -n <name>]
  letta skills list [--agent <id> | -n <name>]
  letta skills delete <skill_name> --agent <id>
  letta backend [cloud|local]
  letta local-backend migrate-transcripts [--storage-dir <path>] [--dry-run]

BEHAVIOR
  On startup, Letta Code checks for saved profiles:
  - If profiles exist, you'll be prompted to select one or create a new agent
  - Agents can be pinned for quick access with /pin
  - Use /profile save <name> to bookmark your current agent

  Agent pins are stored in ~/.letta/settings.json.

  If no credentials are configured, you'll be prompted to authenticate via
  Letta Cloud OAuth on first run.

EXAMPLES
  # when installed as an executable
  letta                    # Show profile selector or create new
  letta --new              # Create new conversation
  letta --agent agent_123  # Open specific agent
  letta install official/finance/stocks --agent agent-123
  letta install npm:@letta-ai/mod-plan-mode

  # inside the interactive session
  /profile save MyAgent    # Save current agent as profile
  /profiles                # Open profile selector
  /pin                     # Pin current agent
  /unpin                   # Unpin current agent
  /logout                  # Clear saved credentials and exit

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
  const { getVersion } = await import("@/version");
  const { SKILLS_DIR } = await import("@/agent/skills");
  const { exists } = await import("@/utils/fs");

  const cwd = process.cwd();
  const skillsDir = join(cwd, SKILLS_DIR);
  const skillsExist = exists(skillsDir);

  // Load local project settings first
  await settingsManager.loadLocalProjectSettings(cwd);

  // Get pinned agents
  const pinned = settingsManager.getPinnedAgents();
  const localSettings = settingsManager.getLocalProjectSettings(cwd);
  const lastAgent = localSettings.lastAgent;

  // Try to fetch agent names from API (if authenticated)
  const agentNames: Record<string, string> = {};
  const allAgentIds = [
    ...new Set([...pinned, ...(lastAgent ? [lastAgent] : [])]),
  ];

  if (allAgentIds.length > 0) {
    try {
      const backend = getBackend();
      // Fetch each agent individually to get accurate names
      await Promise.all(
        allAgentIds.map(async (id) => {
          try {
            const agent = await backend.retrieveAgent(id);
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
  } else if (pinned.length > 0) {
    console.log("Will resume: (will show selector)");
  } else {
    console.log("Will resume: (will create new agent)");
  }

  console.log("");

  // Pinned agents
  if (pinned.length > 0) {
    console.log("Pinned agents:");
    for (const id of pinned) {
      const isLast = id === lastAgent;
      const prefix = isLast ? "→ " : "  ";
      const suffix = isLast ? " (last used)" : "";
      console.log(`  ${prefix}${formatAgent(id)}${suffix}`);
    }
  } else {
    console.log("Pinned agents: (none)");
  }
}

/**
 * Helper to determine which model identifier to pass to loadTools()
 * based on user's model and/or toolset preferences.
 */
function getModelForToolLoading(
  specifiedModel?: string,
  specifiedToolset?: "auto" | "codex" | "default" | "gemini",
): string | undefined {
  // If toolset is explicitly specified, use a dummy model from that provider
  // to trigger the correct toolset loading logic
  if (specifiedToolset === "codex") {
    return "openai/gpt-4";
  }
  if (specifiedToolset === "gemini") {
    return "google_ai/gemini-3.1-pro-preview";
  }
  if (specifiedToolset === "default") {
    return "anthropic/claude-sonnet-4";
  }
  // Otherwise, use the specified model (or undefined for auto-detection)
  return specifiedModel;
}

function getStartupTargetLookupOrderForCredentials({
  baseURL,
  explicitBackendMode,
  lookupOrder,
  apiKey,
  hasRefreshToken,
}: {
  baseURL: string;
  explicitBackendMode?: BackendMode;
  lookupOrder: BackendMode[];
  apiKey?: string;
  hasRefreshToken: boolean;
}): BackendMode[] {
  if (explicitBackendMode) return lookupOrder;
  if (baseURL !== LETTA_CLOUD_API_URL || apiKey || hasRefreshToken) {
    return lookupOrder;
  }
  return lookupOrder.filter((mode) => mode !== "api");
}

/**
 * Resolve an agent ID by name from pinned agents.
 * Case-insensitive exact match. If multiple matches, picks the most recently used.
 */
async function resolveAgentByName(
  name: string,
  backendLookupOrder: BackendMode[],
): Promise<{
  id: string;
  name: string;
  agent: AgentState;
  backendMode: BackendMode;
} | null> {
  const normalizedSearchName = name.toLowerCase();
  const pinnedAgents = await listPinnedAgentsForCurrentUser(backendLookupOrder);

  for (const backendMode of backendLookupOrder) {
    const matches = pinnedAgents.flatMap((pinned) =>
      pinned.backendMode === backendMode &&
      pinned.agent?.name?.toLowerCase() === normalizedSearchName
        ? [
            {
              id: pinned.agentId,
              name: pinned.agent.name,
              agent: pinned.agent,
              backendMode,
            },
          ]
        : [],
    );

    if (matches.length === 0) continue;
    if (matches.length === 1) return matches[0] ?? null;

    // Multiple matches within this backend - pick most recently used.
    const localMatch = matches.find(
      (match) => match.id === settingsManager.getLocalLastAgentId(),
    );
    if (localMatch) return localMatch;

    const globalMatch = matches.find(
      (match) => match.id === settingsManager.getGlobalLastAgentId(),
    );
    if (globalMatch) return globalMatch;

    // Fallback to first match (preserves pinned order for this backend).
    return matches[0] ?? null;
  }

  return null;
}

/**
 * Get all pinned agent names for error messages
 */
async function getPinnedAgentNames(
  backendLookupOrder: BackendMode[],
): Promise<{ id: string; name: string }[]> {
  const pinnedAgents = await listPinnedAgentsForCurrentUser(backendLookupOrder);
  return pinnedAgents.flatMap(({ agentId, agent }) =>
    agent ? [{ id: agentId, name: agent.name || "(unnamed)" }] : [],
  );
}

async function resolveConversationAcrossBackends(
  conversationId: string,
  backendLookupOrder: BackendMode[],
) {
  for (const backendMode of backendLookupOrder) {
    try {
      const backend = getBackendForMode(backendMode);
      const conversation = await backend.retrieveConversation(conversationId);
      return { conversation, backendMode };
    } catch {
      // Conversation does not exist or this backend is unavailable; try fallback.
    }
  }

  return null;
}

type LocalStartupFallbackSession = {
  agentId: string;
  conversationId?: string;
  lastActiveAt: string;
};

function paginatedItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) {
      return maybePage.items;
    }
  }
  return [];
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBackendNotFoundError(error: unknown): boolean {
  return (
    (error instanceof APIError &&
      (error.status === 404 || error.status === 422)) ||
    (error instanceof Error && error.name === "LocalBackendNotFoundError")
  );
}

function isLocalBackendTranscriptStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "LocalTranscriptMigrationRequiredError" ||
    error.name === "LocalTranscriptRepairRequiredError" ||
    error.message.includes("Unsupported local transcript format")
  );
}

async function getLocalBackendStartupFallbackSession(
  backend: Backend,
): Promise<LocalStartupFallbackSession | null> {
  if (
    !backend.capabilities.localModelCatalog &&
    !backend.capabilities.localMemfs
  ) {
    return null;
  }

  const candidates: LocalStartupFallbackSession[] = [];

  try {
    const agentsPage = await backend.listAgents({ limit: 20 } as never);
    for (const agent of paginatedItems<AgentState>(agentsPage)) {
      const lastActiveAt =
        (agent as { last_run_completion?: string | null })
          .last_run_completion ?? "";
      candidates.push({ agentId: agent.id, lastActiveAt });
    }
  } catch {
    // Best-effort repair path. Startup will continue with the normal resolver.
  }

  try {
    const conversationsPage = await backend.listConversations({
      limit: 20,
      order: "desc",
      order_by: "last_run_completion",
    } as never);
    for (const conversation of paginatedItems<{
      id: string;
      agent_id?: string | null;
      last_message_at?: string | null;
      updated_at?: string | null;
      created_at?: string | null;
    }>(conversationsPage)) {
      if (!conversation.agent_id) continue;
      candidates.push({
        agentId: conversation.agent_id,
        ...(conversation.id !== "default"
          ? { conversationId: conversation.id }
          : {}),
        lastActiveAt:
          conversation.last_message_at ??
          conversation.updated_at ??
          conversation.created_at ??
          "",
      });
    }
  } catch {
    // Best-effort repair path. Startup will continue with the normal resolver.
  }

  candidates.sort(
    (a, b) => timestampMs(b.lastActiveAt) - timestampMs(a.lastActiveAt),
  );

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.agentId}:${candidate.conversationId ?? "default"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await backend.retrieveAgent(candidate.agentId, {
        include: ["agent.tags"],
      });
      return candidate;
    } catch {
      // Skip orphaned conversations/records.
    }
  }

  return null;
}

async function main(): Promise<void> {
  markMilestone("CLI_START");

  // Detect if the parent process (Desktop, terminal) dies and we get
  // orphaned to PID 1. Without this, a detached CLI can run for days
  // accumulating memory after the parent exits without cleanly killing it.
  startOrphanDetection();

  const rawCliArgs = process.argv.slice(2);
  let subcommandArgs = rawCliArgs;
  let explicitBackendMode: BackendMode | undefined;
  try {
    const backendSelection = extractBackendFlag(rawCliArgs);
    subcommandArgs = normalizeUpdateCommandAliases(backendSelection.args);
    if (backendSelection.backend) {
      explicitBackendMode = backendSelection.backend;
      configureBackendMode(backendSelection.backend);
    }
  } catch (error) {
    trackCliBoundaryError(
      "cli_backend_flag_parse_failed",
      error,
      "startup_backend_flag_parse",
    );
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    process.exit(1);
  }

  if (subcommandNeedsEarlyBackendMode(subcommandArgs[0])) {
    const savedBackendSettings =
      settingsManager.readStartupBackendSettingsSync();
    const localBackendEnvValue = process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
    const envBackendMode =
      localBackendEnvValue === undefined
        ? undefined
        : localBackendEnvValue === "1" ||
            localBackendEnvValue.toLowerCase() === "true"
          ? "local"
          : "api";
    const backendMode = resolveSubcommandBackendMode({
      explicitBackendMode,
      envBackendMode,
      savedBackendMode: savedBackendSettings.preferredBackendMode,
      baseURL:
        process.env.LETTA_BASE_URL ||
        savedBackendSettings.envBaseUrl ||
        LETTA_CLOUD_API_URL,
      cloudBaseURL: LETTA_CLOUD_API_URL,
    });
    if (backendMode) {
      configureBackendMode(backendMode);
    }
  }

  // Early exit for CLI subcommands (e.g., `letta server`, `letta memory`).
  // Subcommands handle their own setup and don't need TUI init, theme
  // detection, or base tool bootstrapping.
  const subcommandResult = await runSubcommand(subcommandArgs);
  if (subcommandResult !== null) {
    process.exit(subcommandResult);
  }

  // Everything below only runs for interactive/headless agent mode
  await settingsManager.initialize();

  const settings = await settingsManager.getSettingsWithSecureTokens();
  markMilestone("SETTINGS_LOADED");

  // Initialize LSP infrastructure for type checking
  if (process.env.LETTA_ENABLE_LSP) {
    try {
      const { lspManager } = await import("@/lsp/manager.js");
      await lspManager.initialize(process.cwd());
    } catch (error) {
      trackCliBoundaryError("lsp_init_failed", error, "tui_startup_lsp_init");
      console.error("[LSP] Failed to initialize:", error);
    }
  }

  // Check for updates on startup (non-blocking)
  const { checkAndAutoUpdate } = await import("@/updater/auto-update");
  const autoUpdatePromise = startStartupAutoUpdateCheck(checkAndAutoUpdate);

  // Parse command-line arguments from a shared schema used by both TUI and headless flows.
  // Preprocess args to support legacy aliases before strict parsing.
  const processedArgs = preprocessCliArgs([
    process.argv[0] ?? "node",
    process.argv[1] ?? "letta",
    ...subcommandArgs,
  ]);

  let values: ParsedCliArgs["values"];
  let positionals: ParsedCliArgs["positionals"];
  try {
    const parsed = parseCliArgs(processedArgs, true);
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    trackCliBoundaryError(
      "cli_args_parse_failed",
      error,
      "tui_startup_parse_args",
    );
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

    // Test-only hook to keep process alive briefly so startup auto-update can run.
    const helpDelayMs = Number.parseInt(
      process.env.LETTA_TEST_HELP_EXIT_DELAY_MS ?? "",
      10,
    );
    if (Number.isFinite(helpDelayMs) && helpDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, helpDelayMs));
    }

    process.exit(0);
  }

  // Handle version flag
  if (values.version) {
    const { getVersion } = await import("@/version");
    console.log(`${getVersion()} (Letta Code)`);
    process.exit(0);
  }

  // Handle info flag
  if (values.info) {
    await printInfo();
    process.exit(0);
  }

  // --resume: Open agent selector UI after loading
  const shouldResume = values.resume ?? false;
  let specifiedConversationId = values.conversation ?? null; // Specific conversation to resume
  const forceNew = values["new-agent"] ?? false;

  // --new: Create a new conversation (for concurrent sessions)
  const forceNewConversation = values.new ?? false;

  const baseToolsRaw = values["base-tools"];
  let specifiedAgentId = values.agent ?? null;
  try {
    const normalized = normalizeConversationShorthandFlags({
      specifiedConversationId,
      specifiedAgentId,
    });
    specifiedConversationId = normalized.specifiedConversationId ?? null;
    specifiedAgentId = normalized.specifiedAgentId ?? null;
  } catch (error) {
    trackCliBoundaryError(
      "conversation_shorthand_normalization_failed",
      error,
      "tui_startup_conversation_shorthand",
    );
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    process.exit(1);
  }

  // Validate --conv default requires --agent (unless --new-agent will create one)
  try {
    validateConversationDefaultRequiresAgent({
      specifiedConversationId,
      specifiedAgentId,
      forceNew,
    });
  } catch (error) {
    trackCliBoundaryError(
      "conversation_flag_validation_failed",
      error,
      "tui_startup_conversation_flag_validation",
    );
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    console.error("Usage: letta --agent agent-xyz --conv default");
    console.error("   or: letta --conv agent-xyz (shorthand)");
    process.exit(1);
  }

  const specifiedAgentName = values.name ?? null;
  const inferredBackendModeFromAgentId =
    inferBackendModeFromAgentId(specifiedAgentId);
  if (!explicitBackendMode && inferredBackendModeFromAgentId) {
    configureBackendMode(inferredBackendModeFromAgentId);
  }
  const setupLocalModeDisabledReason =
    !explicitBackendMode &&
    specifiedAgentId &&
    inferredBackendModeFromAgentId === "api"
      ? `Agent ${specifiedAgentId} is a Constellation agent. Sign in to access it, or rerun without --agent to start locally.`
      : undefined;
  const specifiedModel = values.model ?? undefined;
  const systemPromptPreset = values.system ?? undefined;
  const systemCustom = values["system-custom"] ?? undefined;
  const personalityInput = values.personality ?? undefined;
  const specifiedToolset = values.toolset ?? undefined;
  const skillsDirectory = values.skills ?? undefined;
  const memfsFlag = values.memfs;
  const noSkillsFlag = values["no-skills"];
  const noBundledSkillsFlag = values["no-bundled-skills"];
  const skillSourcesRaw = values["skill-sources"];
  const noSystemInfoReminderFlag = values["no-system-info-reminder"];
  const modsDisabled = shouldDisableMods({
    cliFlag: values["no-mods"],
  });
  if (modsDisabled) {
    disableModsForProcess();
  }
  const resolvedSkillSources = (() => {
    try {
      return resolveSkillSourcesSelection({
        skillSourcesRaw,
        noSkills: noSkillsFlag,
        noBundledSkills: noBundledSkillsFlag,
      });
    } catch (error) {
      console.error(
        error instanceof Error ? `Error: ${error.message}` : String(error),
      );
      process.exit(1);
    }
  })();
  const fromAfFile = resolveImportFlagAlias({
    importFlagValue: values.import,
    fromAfFlagValue: values["from-af"],
  });
  const isHeadless = values.prompt || values.run || !process.stdin.isTTY;
  const terminalThemePromise = !isHeadless
    ? initTerminalTheme().catch(() => undefined)
    : Promise.resolve(undefined);
  // Terminal preflight must happen before Ink takes over stdin. Start it as
  // early as possible so OSC/Kitty handshakes are hidden behind auth checks,
  // argument validation, and module loading instead of sitting in front of
  // first render.
  const terminalPreflightPromise = !isHeadless
    ? (async () => {
        await terminalThemePromise;
        try {
          const { detectAndEnableKittyProtocol } = await import(
            "@/cli/utils/kitty-protocol-detector"
          );
          await detectAndEnableKittyProtocol();
        } catch {
          // Best-effort: if this fails, the app still runs (Option+Enter remains supported).
        }
      })()
    : Promise.resolve(undefined);
  const ensureTerminalPreflightComplete = async () => {
    await terminalPreflightPromise;
  };

  let apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;
  const tryConfigureStartupLocalBackend = async (): Promise<boolean> => {
    try {
      configureBackendMode("local");
      return true;
    } catch (error) {
      if (!isLocalBackendTranscriptStartupError(error)) {
        throw error;
      }
      console.warn(
        `Local backend data needs migration before it can be used: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.warn(
        "Continuing to setup/login so local transcript migration does not block account access.",
      );
      configureBackendMode("api");
      settingsManager.updateSettings({ preferredBackendMode: "api" });
      await settingsManager.flush();
      return false;
    }
  };

  if (
    !explicitBackendMode &&
    !inferredBackendModeFromAgentId &&
    settings.preferredBackendMode === "local" &&
    baseURL === LETTA_CLOUD_API_URL
  ) {
    await tryConfigureStartupLocalBackend();
  }

  // Local-first new-user flow: if the user has no Letta Cloud credentials and
  // did not explicitly request a backend, start in local mode immediately so
  // they can type right away. Existing local agents will be resumed below; if
  // none exist, startup falls through to local default-agent creation.
  if (
    !explicitBackendMode &&
    !inferredBackendModeFromAgentId &&
    !isHeadless &&
    baseURL === LETTA_CLOUD_API_URL &&
    !settings.refreshToken &&
    !apiKey
  ) {
    if (await tryConfigureStartupLocalBackend()) {
      settingsManager.updateSettings({ preferredBackendMode: "local" });
      await settingsManager.flush();
    }
  }

  const startupTargetLookupOrder = getStartupTargetLookupOrderForCredentials({
    baseURL,
    explicitBackendMode,
    lookupOrder: getStartupBackendLookupOrder(
      isExperimentalLocalBackendEnabled() ? "local" : "api",
      explicitBackendMode,
    ),
    apiKey,
    hasRefreshToken: Boolean(settings.refreshToken),
  });

  const requestedMemoryPromptMode: "memfs" | undefined = memfsFlag
    ? "memfs"
    : undefined;
  const shouldAutoEnableMemfsForNewAgent = !memfsFlag;

  // Initialize telemetry (enabled by default, opt-out via LETTA_CODE_TELEM=0)
  // Surface is set here so session_start captures the correct mode.
  telemetry.setSurface(getTerminalTelemetrySurface(isHeadless));
  telemetry.init({ handleSigint: !isHeadless });

  if (!isHeadless) {
    // TUI-only startup tasks: keep headless runs free of extra background work.
    const { startDockerVersionCheck } = await import("@/startup-docker-check");
    startDockerVersionCheck().catch(() => {});

    const { cleanupOldOverflowFiles } = await import("@/tools/impl/overflow");
    Promise.resolve().then(() => {
      try {
        cleanupOldOverflowFiles(process.cwd());
      } catch {
        // Silently ignore cleanup failures
      }
    });
  }

  // Fail if an unknown command/argument is passed (and we're not in headless mode where it might be a prompt)
  if (command && !isHeadless) {
    console.error(`Error: Unknown command or argument "${command}"`);
    console.error("Run 'letta --help' for usage information.");
    process.exit(1);
  }

  // --base-tools only makes sense when creating a brand new agent
  if (baseToolsRaw && !forceNew) {
    console.error(
      "Error: --base-tools can only be used together with --new to control initial base tools.",
    );
    process.exit(1);
  }

  const baseTools = parseCsvListFlag(baseToolsRaw);

  const personality = personalityInput
    ? resolvePersonalityId(personalityInput)
    : null;
  if (personalityInput && !personality) {
    console.error(
      `Error: Unknown personality "${personalityInput}". Valid: letta-code, tutorial, blank, linus, kawaii, claude, codex`,
    );
    process.exit(1);
  }
  if (personalityInput && !forceNew) {
    console.error("Error: --personality can only be used with --new-agent");
    process.exit(1);
  }

  // Validate toolset if provided
  if (
    specifiedToolset &&
    specifiedToolset !== "codex" &&
    specifiedToolset !== "default" &&
    specifiedToolset !== "gemini" &&
    specifiedToolset !== "auto"
  ) {
    console.error(
      `Error: Invalid toolset "${specifiedToolset}". Must be "auto", "codex", "default", or "gemini".`,
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

  // Validate system prompt preset if provided.
  // Known preset IDs are always accepted. Subagent names are only accepted
  // for internal subagent launches (LETTA_CODE_AGENT_ROLE=subagent).
  if (systemPromptPreset) {
    const { validateSystemPromptPreset } = await import(
      "@/agent/system-prompt-resolution"
    );
    const allowSubagentNames = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
    try {
      await validateSystemPromptPreset(systemPromptPreset, {
        allowSubagentNames,
      });
    } catch (err) {
      trackCliBoundaryError(
        "system_prompt_preset_validation_failed",
        err,
        "tui_startup_system_prompt_preset",
      );
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  // Validate shared mutual-exclusion rules for startup flags.
  try {
    validateFlagConflicts({
      guard: specifiedConversationId && specifiedConversationId !== "default",
      checks: [
        {
          when: specifiedAgentId,
          message: "--conversation cannot be used with --agent",
        },
        {
          when: specifiedAgentName,
          message: "--conversation cannot be used with --name",
        },
        {
          when: forceNew,
          message: "--conversation cannot be used with --new-agent",
        },
        {
          when: fromAfFile,
          message: "--conversation cannot be used with --import",
        },
        {
          when: shouldResume,
          message: "--conversation cannot be used with --resume",
        },
      ],
    });

    validateFlagConflicts({
      guard: forceNewConversation,
      checks: [
        {
          when: specifiedConversationId,
          message: "--new cannot be used with --conversation",
        },
        { when: shouldResume, message: "--new cannot be used with --resume" },
      ],
    });
  } catch (error) {
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    process.exit(1);
  }

  // Validate --import flag (also accepts legacy --from-af)
  // Detect if it's a registry handle (e.g., @author/name) or a local file path
  let isRegistryImport = false;
  if (fromAfFile) {
    try {
      validateFlagConflicts({
        guard: fromAfFile,
        checks: [
          {
            when: specifiedAgentId,
            message: "--import cannot be used with --agent",
          },
          {
            when: specifiedAgentName,
            message: "--import cannot be used with --name",
          },
          {
            when: shouldResume,
            message: "--import cannot be used with --resume",
          },
          {
            when: forceNew,
            message: "--import cannot be used with --new-agent",
          },
        ],
      });
    } catch (error) {
      console.error(
        error instanceof Error ? `Error: ${error.message}` : String(error),
      );
      process.exit(1);
    }

    // Check if this looks like a registry handle (@author/name)
    if (fromAfFile.startsWith("@")) {
      // Definitely a registry handle
      isRegistryImport = true;
      // Validate handle format
      try {
        validateRegistryHandleOrThrow(fromAfFile);
      } catch {
        console.error(
          `Error: Invalid registry handle "${fromAfFile}". Use format: letta --import @author/agentname`,
        );
        process.exit(1);
      }
    } else {
      // Local file - verify it exists
      const { resolve } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const resolvedPath = resolve(fromAfFile);
      if (!existsSync(resolvedPath)) {
        console.error(`Error: AgentFile not found: ${resolvedPath}`);
        process.exit(1);
      }
    }
  }

  // Validate --name flag
  let nameResolvedAgent: AgentState | null = null;
  if (specifiedAgentName) {
    if (specifiedAgentId) {
      console.error("Error: --name cannot be used with --agent");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --name cannot be used with --new-agent");
      process.exit(1);
    }
  }

  const isUsingDevBackend =
    isHeadless &&
    typeof values["dev-backend"] === "string" &&
    values["dev-backend"].length > 0;
  const isUsingLocalBackend = isExperimentalLocalBackendEnabled();

  if (!isUsingDevBackend && !isUsingLocalBackend) {
    // Headless mode against Letta API requires an explicit LETTA_API_KEY env var.
    // Stored interactive OAuth tokens are not accepted for automated/headless use.
    if (
      isHeadless &&
      baseURL === LETTA_CLOUD_API_URL &&
      !process.env.LETTA_API_KEY
    ) {
      console.error("Missing LETTA_API_KEY");
      console.error(
        "Headless mode requires an API key set via the LETTA_API_KEY environment variable.",
      );
      console.error(`Get an API key at ${LETTA_CHAT_API_KEYS_URL}`);
      process.exit(1);
    }

    // Check if refresh token is missing for Letta Cloud (only when not using env var)
    // Skip this check if we already have an API key from env
    if (
      !isHeadless &&
      baseURL === LETTA_CLOUD_API_URL &&
      !settings.refreshToken &&
      !apiKey
    ) {
      // For interactive mode, show setup flow
      await ensureTerminalPreflightComplete();
      const { runSetup } = await import("@/auth/setup");
      const setupResult = await runSetup({
        localModeDisabledReason: setupLocalModeDisabledReason,
      });
      if (setupResult.kind === "cancelled") {
        process.exit(0);
      }
      // After setup, restart main flow
      return main().catch((err: unknown) => {
        // Handle top-level errors gracefully without raw stack traces
        trackCliBoundaryError("setup_restart_failed", err, "tui_setup_restart");
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred";
        console.error(`\nError: ${message}`);
        if (isDebugEnabled()) {
          console.error(err);
        }
        process.exit(1);
      });
    }

    if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
      // For interactive mode, show setup flow
      console.log("No credentials found. Let's get you set up!\n");
      await ensureTerminalPreflightComplete();
      const { runSetup } = await import("@/auth/setup");
      const setupResult = await runSetup({
        localModeDisabledReason: setupLocalModeDisabledReason,
      });
      if (setupResult.kind === "cancelled") {
        process.exit(0);
      }
      // After setup, restart main flow
      return main();
    }

    if (
      !process.env.LETTA_API_KEY &&
      baseURL === LETTA_CLOUD_API_URL &&
      settings.refreshToken &&
      settings.tokenExpiresAt &&
      (!apiKey || settings.tokenExpiresAt - Date.now() < 5 * 60 * 1000)
    ) {
      apiKey = (await refreshStartupOAuthToken(settings)) ?? apiKey;
    }

    // Cloud always requires credentials. Custom API backends may be
    // intentionally unauthenticated, so only validate them when a key is present.
    const shouldValidateCredentials =
      baseURL === LETTA_CLOUD_API_URL || Boolean(apiKey);

    if (shouldValidateCredentials) {
      // Validate credentials by checking an authenticated endpoint. Startups
      // that use API credentials should preserve targeted invalid-key/network
      // handling; the terminal preflight above already runs in parallel with
      // this request, so most of the cost is hidden in interactive mode.
      const { validateCredentialsWithResult } = await import("@/auth/oauth");
      let credentialValidation = await validateCredentialsWithResult(
        baseURL,
        apiKey ?? "",
      );
      let isValid = credentialValidation.ok;

      if (
        !isValid &&
        !process.env.LETTA_API_KEY &&
        baseURL === LETTA_CLOUD_API_URL &&
        settings.refreshToken
      ) {
        const refreshedApiKey = await refreshStartupOAuthToken(settings);
        if (refreshedApiKey) {
          apiKey = refreshedApiKey;
          credentialValidation = await validateCredentialsWithResult(
            baseURL,
            apiKey,
          );
          isValid = credentialValidation.ok;
        }
      }
      markMilestone("CREDENTIALS_VALIDATED");

      // Ensure base tools exist on the server (first-run-per-machine,
      // backgrounded for interactive startup). Must run after credentials are
      // validated so OAuth tokens are available.
      if (isValid) {
        const bootstrapPromise = import("@/agent/bootstrap-tools").then(
          ({ bootstrapBaseToolsIfNeeded }) => bootstrapBaseToolsIfNeeded(),
        );
        if (isHeadless) {
          await bootstrapPromise;
        } else {
          void bootstrapPromise.catch((error) => {
            debugWarn(
              "startup",
              `Failed to bootstrap base tools: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }

      if (!isValid) {
        const validationFailure = credentialValidation.ok
          ? null
          : credentialValidation;

        if (isHeadless) {
          console.error("Failed to connect to Letta server");
          console.error(`Base URL: ${baseURL}`);
          console.error(
            "Your credentials may be invalid or the server may be unreachable.",
          );
          if (validationFailure?.message) {
            console.error(`Details: ${validationFailure.message}`);
          }
          if (process.env.LETTA_API_KEY) {
            console.error(
              "LETTA_API_KEY is set in your environment. Unset or update LETTA_API_KEY, then run `letta` again.",
            );
          } else {
            console.error("Run `letta setup` to re-authenticate.");
          }
          process.exit(1);
        }

        console.log("Failed to connect to Letta server.");
        console.log(`Base URL: ${baseURL}\n`);
        console.log(
          "Your credentials may be invalid or the server may be unreachable.",
        );
        if (process.env.LETTA_API_KEY) {
          console.log(
            "LETTA_API_KEY is set in your environment, so setup cannot replace the credential Letta Code is using.",
          );
          console.log(
            "Unset LETTA_API_KEY or update it with a valid API key, then run `letta` again.",
          );
          process.exit(1);
        }

        if (
          validationFailure?.reason === "network_error" ||
          validationFailure?.reason === "server_unreachable"
        ) {
          if (validationFailure.message) {
            console.log(`Details: ${validationFailure.message}`);
          }
          console.log(
            "Setup cannot fix a server reachability problem. Check your network or try again later.",
          );
          process.exit(1);
        }

        console.log("Let's reauthenticate your setup.\n");
        await ensureTerminalPreflightComplete();
        const { runSetup } = await import("@/auth/setup");
        const setupResult = await runSetup({
          initialMode: baseURL === LETTA_CLOUD_API_URL ? "device-code" : "menu",
          localModeDisabledReason: setupLocalModeDisabledReason,
        });
        if (setupResult.kind === "cancelled") {
          process.exit(0);
        }
        // After setup, restart main flow
        return main();
      }
    } else {
      markMilestone("CREDENTIALS_VALIDATED");
    }
  } else {
    markMilestone("CREDENTIALS_VALIDATED");
  }

  // Resolve --name to agent ID if provided
  if (specifiedAgentName) {
    // Load local settings for LRU priority
    await settingsManager.loadLocalProjectSettings();

    const resolved = await resolveAgentByName(
      specifiedAgentName,
      startupTargetLookupOrder,
    );
    if (!resolved) {
      console.error(
        `Error: No pinned agent found with name "${specifiedAgentName}"`,
      );
      console.error("");
      const pinnedAgents = await getPinnedAgentNames(startupTargetLookupOrder);
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
    configureBackendMode(resolved.backendMode);
    specifiedAgentId = resolved.id;
    nameResolvedAgent = resolved.agent;
  }

  // Set tool filter if provided (controls which tools are loaded)
  if (values.tools !== undefined) {
    const { toolFilter } = await import("@/tools/filter");
    toolFilter.setEnabledTools(values.tools);
  }

  // Set CLI permission overrides if provided
  if (
    values.allowedTools ||
    values.disallowedTools ||
    values["disable-memory-guard"]
  ) {
    const { cliPermissions } = await import(
      "@/permissions/cli-permissions-instance"
    );
    if (values.allowedTools) {
      cliPermissions.setAllowedTools(values.allowedTools);
    }
    if (values.disallowedTools) {
      cliPermissions.setDisallowedTools(values.disallowedTools);
    }
    if (values["disable-memory-guard"]) {
      cliPermissions.setMemoryGuardDisabled(true);
    }
  }

  // Set permission mode if provided (or via --yolo alias)
  const permissionModeValue =
    typeof values["permission-mode"] === "string"
      ? values["permission-mode"]
      : undefined;
  const yoloMode = values.yolo;
  const startupPermissionMode = await applyStartupPermissionMode({
    permissionModeValue,
    yoloMode,
  });
  if (!startupPermissionMode.ok) {
    console.error(startupPermissionMode.message);
    process.exit(1);
  }

  if (isHeadless) {
    markMilestone("HEADLESS_MODE_START");
    // For headless mode, load tools synchronously (respecting model/toolset when provided)
    const modelForTools = getModelForToolLoading(
      specifiedModel,
      specifiedToolset as "auto" | "codex" | "default" | "gemini" | undefined,
    );
    // Exclude interactive-only tools that can't function without a live user session
    await loadTools(modelForTools, { exclude: ["AskUserQuestion"] });
    markMilestone("TOOLS_LOADED");

    // Keep headless startup in sync with interactive name resolution.
    // If --name resolved to an agent ID, pass that through as --agent.
    const headlessValues =
      specifiedAgentId && values.agent !== specifiedAgentId
        ? { ...values, agent: specifiedAgentId }
        : values;

    const { handleHeadlessCommand } = await import("@/headless");
    await handleHeadlessCommand(
      { values: headlessValues, positionals },
      specifiedModel,
      skillsDirectory,
      resolvedSkillSources,
      !noSystemInfoReminderFlag,
      { requestedBackendMode: explicitBackendMode },
    );
    return;
  }

  markMilestone("TUI_MODE_START");

  // Interactive: lazy-load React/Ink + App
  markMilestone("REACT_IMPORT_START");
  const [React, { render }, AppModule] = await Promise.all([
    import("react"),
    import("ink"),
    import("@/cli/App"),
  ]);
  markMilestone("REACT_IMPORT_DONE");
  await terminalPreflightPromise;
  markMilestone("TERMINAL_PREFLIGHT_DONE");
  const { useState, useEffect, useRef } = React;
  const App = AppModule.App;

  function LoadingApp({
    forceNew,
    baseTools,
    agentIdArg,
    preResolvedAgent,
    model,
    systemPromptPreset,
    toolset,
    skillsDirectory,
    fromAfFile,
    isRegistryImport,
  }: {
    forceNew: boolean;
    baseTools?: string[];
    agentIdArg: string | null;
    preResolvedAgent?: AgentState | null;
    model?: string;
    systemPromptPreset?: string;
    toolset?: "auto" | "codex" | "default" | "gemini";
    skillsDirectory?: string;
    fromAfFile?: string;
    isRegistryImport?: boolean;
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
    const startupCreatedAgentRef = useRef<AgentState | null>(null);
    const [startupHasCloudCredentials, setStartupHasCloudCredentials] =
      useState(Boolean(settings.refreshToken || apiKey));
    const [fileAutocompleteFdPath, setFileAutocompleteFdPath] = useState<
      string | null
    >(() => resolveFdPath());
    const [startupHasAvailableLocalModels, setStartupHasAvailableLocalModels] =
      useState(true);
    // Cache agent object from Phase 1 validation to avoid redundant re-fetch in Phase 2
    const [validatedAgent, setValidatedAgent] = useState<AgentState | null>(
      preResolvedAgent ?? null,
    );
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
    // For custom API backends: available model handles from server and user's selection
    const [availableServerModels, setAvailableServerModels] = useState<
      string[]
    >([]);
    const [selectedServerModel, setSelectedServerModel] = useState<
      string | null
    >(null);
    const [
      selectedServerModelReasoningEffort,
      setSelectedServerModelReasoningEffort,
    ] = useState<ModelReasoningEffort | null>(null);
    const [customApiDefaultModel, setCustomApiDefaultModel] = useState<
      string | null
    >(null);
    const [customApiBaseUrl, setCustomApiBaseUrl] = useState<string | null>(
      null,
    );

    // Release notes to display (checked once on mount)
    const [releaseNotes, setReleaseNotes] = useState<string | null>(null);

    // Update notification: set when auto-update applied a significant new version
    const [updateNotification, setUpdateNotification] = useState<string | null>(
      null,
    );
    useEffect(() => {
      autoUpdatePromise
        .then((result) => {
          if (result?.latestVersion) {
            setUpdateNotification(result.latestVersion);
          }
        })
        .catch(() => {});
    }, []);

    // Auto-install Shift+Enter keybinding for VS Code/Cursor/Windsurf (silent, no prompt)
    useEffect(() => {
      async function autoInstallKeybinding() {
        const {
          detectTerminalType,
          getKeybindingsPath,
          keybindingExists,
          installKeybinding,
        } = await import("@/cli/utils/terminal-keybinding-installer");
        const { loadSettings, updateSettings } = await import("@/settings");

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
        } = await import("@/cli/utils/terminal-keybinding-installer");
        const { loadSettings, updateSettings } = await import("@/settings");

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
        const { checkReleaseNotes } = await import("@/release-notes");
        const notes = await checkReleaseNotes();
        setReleaseNotes(notes);
      }
      checkNotes();
    }, []);

    // Initialize on mount - check if we should show global agent selector
    useEffect(() => {
      async function checkAndStart() {
        markMilestone("TUI_CHECK_AND_START");
        // Load settings
        await settingsManager.loadLocalProjectSettings();
        const backend = getBackend();
        const startupBackendMode = isExperimentalLocalBackendEnabled()
          ? "local"
          : "api";

        // For custom API backends, available-model discovery can require a
        // slow network/API round trip. It is only used to improve the fresh
        // "create agent" model picker, so keep it off the startup decision path.
        const baseURL =
          process.env.LETTA_BASE_URL ||
          settings.env?.LETTA_BASE_URL ||
          LETTA_CLOUD_API_URL;
        const isCustomApiBackend =
          startupBackendMode !== "local" && !baseURL.includes("api.letta.com");
        setStartupHasCloudCredentials(Boolean(settings.refreshToken || apiKey));
        const startupModelsPromise =
          startupBackendMode === "local"
            ? backend.listModels()
            : Promise.resolve([]);
        if (startupBackendMode === "local") {
          // Local model discovery can hit slow/unreachable provider endpoints
          // (bounded by the discovery timeout). It is only needed for the UI
          // availability hint, so never block disk-backed agent resume on it.
          void startupModelsPromise
            .then((models) => {
              markMilestone("LOCAL_MODEL_DISCOVERY_DONE");
              setStartupHasAvailableLocalModels(models.length > 0);
            })
            .catch(() => {
              markMilestone("LOCAL_MODEL_DISCOVERY_DONE");
              setStartupHasAvailableLocalModels(false);
            });
        } else {
          setStartupHasAvailableLocalModels(true);
        }

        // Model picker availability is populated opportunistically below. Do
        // not block startup on it; fresh-agent creation can fail naturally or
        // be retried with an explicit model.
        const needsModelPicker = false;

        if (isCustomApiBackend) {
          setCustomApiBaseUrl(baseURL);
          const modelPrefetchTimer = setTimeout(() => {
            void import("@/agent/model")
              .then(({ getDefaultModel }) => {
                const defaultModel = getDefaultModel();
                setCustomApiDefaultModel(defaultModel);
                return backend.listModels().then((modelsList) => {
                  markMilestone("CUSTOM_API_MODEL_PREFETCH_DONE");
                  const handles = modelsList
                    .map((m) => m.handle)
                    .filter((h): h is string => typeof h === "string");

                  // Only show the custom-API model picker helper when the
                  // default model is unavailable, but never wait on this before
                  // deciding whether to resume/select/create.
                  if (!handles.includes(defaultModel)) {
                    setAvailableServerModels(handles);
                  }
                });
              })
              .catch(() => {
                // Ignore errors - will fail naturally during agent creation if needed.
              });
          }, 1000);
          modelPrefetchTimer.unref?.();
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

          debugLog(
            "conversations",
            `retrieve(${specifiedConversationId}) [TUI conv→agent lookup]`,
          );
          const resolved = await resolveConversationAcrossBackends(
            specifiedConversationId,
            startupTargetLookupOrder,
          );
          if (!resolved) {
            console.error(`Conversation ${specifiedConversationId} not found`);
            process.exit(1);
          }
          configureBackendMode(resolved.backendMode);
          // Use the agent that owns this conversation
          setSelectedGlobalAgentId(resolved.conversation.agent_id);
          setSelectedConversationId(specifiedConversationId);
          setLoadingState("assembling");
          return;
        }

        // =====================================================================
        // TOP-LEVEL PATH: --resume
        // Show conversation selector for last-used agent (local → global fallback)
        // =====================================================================
        if (shouldResume) {
          const localSession = settingsManager.getLocalLastSession(
            process.cwd(),
          );
          const localAgentId =
            localSession?.agentId ??
            settingsManager.getLocalLastAgentId(process.cwd());
          const globalSession = settingsManager.getGlobalLastSession();
          const globalAgentId = globalSession?.agentId;

          // Both LRU getters already filter by the active server key (which
          // encodes the backend mode), so no extra compatibility check is
          // needed here.
          const preferredResumeAgentId =
            (startupBackendMode === "local" ? localAgentId : globalAgentId) ??
            null;

          if (preferredResumeAgentId) {
            try {
              const agent = await backend.retrieveAgent(
                preferredResumeAgentId,
                {
                  include: ["agent.tags"],
                },
              );
              setResumeAgentId(preferredResumeAgentId);
              setResumeAgentName(agent.name ?? null);
              setLoadingState("selecting_conversation");
              return;
            } catch {
              setFailedAgentMessage(
                `Unable to locate agent ${preferredResumeAgentId}`,
              );
            }
          }

          // No valid agent found anywhere
          console.error("No recent session found in .letta/ or ~/.letta.");
          console.error("Run 'letta' to get started.");
          process.exit(1);
        }

        // =====================================================================
        // DEFAULT PATH: No special flags
        // Check local LRU → global LRU → selector → create default
        // =====================================================================

        // Short-circuit: flags handled by init() skip resolution entirely
        if (forceNew || agentIdArg || fromAfFile) {
          // For --agent/--name: restore conversation from local session if the
          // agent matches, so we don't clobber a real conv ID with "default".
          if (agentIdArg && !forceNew && !fromAfFile && !forceNewConversation) {
            // loadLocalProjectSettings is cached if already loaded (e.g. --name)
            await settingsManager.loadLocalProjectSettings(process.cwd());
            const localSession = settingsManager.getLocalLastSession(
              process.cwd(),
            );
            if (
              localSession?.agentId === agentIdArg &&
              localSession.conversationId &&
              localSession.conversationId !== "default"
            ) {
              setSelectedConversationId(localSession.conversationId);
            }
          }
          setLoadingState("assembling");
          return;
        }

        // Check recent session state for the active backend.
        const localAgentId = settingsManager.getLocalLastAgentId(process.cwd());
        const globalAgentId =
          startupBackendMode === "api"
            ? settingsManager.getGlobalLastAgentId()
            : null;
        const localSession = settingsManager.getLocalLastSession(process.cwd());

        // Validate the project target before a large pin set can flood the API.
        if (localAgentId) {
          try {
            const localAgent = await backend.retrieveAgent(localAgentId, {
              include: ["agent.tags"],
            });
            setSelectedGlobalAgentId(localAgentId);
            setValidatedAgent(localAgent);
            if (localSession?.conversationId && !forceNewConversation) {
              setSelectedConversationId(localSession.conversationId);
            }
            markMilestone("STARTUP_LRU_FETCH_DONE");
            setLoadingState("assembling");
            return;
          } catch {
            setFailedAgentMessage(
              `Unable to locate recently used agent ${localAgentId}`,
            );
          }
        }

        const pinnedAgents = await listPinnedAgentsForCurrentUser([
          startupBackendMode,
        ]);
        const pinnedAgentIds = pinnedAgents.map(({ agentId }) => agentId);
        const cachedAgents = new Map(
          pinnedAgents.flatMap(({ agentId, agent }) =>
            agent ? [[agentId, agent] as const] : [],
          ),
        );
        if (globalAgentId && !cachedAgents.has(globalAgentId)) {
          try {
            const globalAgent = await backend.retrieveAgent(globalAgentId, {
              include: ["agent.tags"],
            });
            cachedAgents.set(globalAgentId, globalAgent);
          } catch {
            // Continue to pinned agents or fresh-start fallback.
          }
        }

        // A single existing pin resumes directly; multiple pins open selection.
        const existingPinnedIds = pinnedAgentIds.filter((id) =>
          cachedAgents.has(id),
        );
        const pinnedAgentId =
          existingPinnedIds.length === 1
            ? (existingPinnedIds[0] ?? null)
            : null;
        const pinnedAgentExists = pinnedAgentId !== null;
        const globalAgentExists = globalAgentId
          ? cachedAgents.has(globalAgentId)
          : false;
        markMilestone("STARTUP_LRU_FETCH_DONE");

        // Resolve the remaining fallback target.
        const fallbackSession =
          startupBackendMode === "local" && !globalAgentExists
            ? await getLocalBackendStartupFallbackSession(backend)
            : null;
        const { resolveStartupTarget } = await import(
          "@/agent/resolve-startup-agent"
        );
        const target = resolveStartupTarget({
          pinnedAgentId,
          pinnedAgentExists,
          pinnedCount: pinnedAgentIds.length,
          existingPinnedCount: existingPinnedIds.length,
          localAgentId,
          localConversationId: localSession?.conversationId ?? null,
          localAgentExists: false,
          globalAgentId,
          globalAgentExists,
          fallbackAgentId: fallbackSession?.agentId ?? null,
          fallbackConversationId: fallbackSession?.conversationId ?? null,
          forceNew: false, // forceNew short-circuited above
          needsModelPicker,
        });
        markMilestone(`STARTUP_TARGET_${target.action.toUpperCase()}`);

        switch (target.action) {
          case "resume": {
            setSelectedGlobalAgentId(target.agentId);
            const cachedAgent = cachedAgents.get(target.agentId);
            if (cachedAgent) {
              setValidatedAgent(cachedAgent);
            }
            if (target.conversationId && !forceNewConversation) {
              setSelectedConversationId(target.conversationId);
            }
            setLoadingState("assembling");
            return;
          }
          case "select":
            setLoadingState("selecting_global");
            return;
          case "create": {
            const { ensureDefaultAgents } = await import("@/agent/defaults");
            try {
              const defaultAgent = await ensureDefaultAgents(getBackend(), {
                preferredModel: model,
                // True fresh start (brand-new account, nothing to resume)
                // gets the Tutor onboarding agent; an explicit --new-agent
                // gets the standard Letta Code agent.
                personality:
                  target.trigger === "fresh-start" ? "tutorial" : "memo",
              });
              if (defaultAgent) {
                startupCreatedAgentRef.current = defaultAgent;
                setAgentProvenance({ isNew: true, blocks: [] });
                setValidatedAgent(defaultAgent);
                setSelectedGlobalAgentId(defaultAgent.id);
                setLoadingState("assembling");
                return;
              }
              // If null (createDefaultAgents disabled), fall through
            } catch (err) {
              console.error(
                `Failed to create default agent: ${err instanceof Error ? err.message : String(err)}`,
              );
              process.exit(1);
            }
            break;
          }
        }

        setLoadingState("assembling");
      }
      checkAndStart();
    }, [
      forceNew,
      agentIdArg,
      fromAfFile,
      shouldResume,
      specifiedConversationId,
    ]);

    // Main initialization effect - runs after profile selection
    const initStartedRef = React.useRef(false);

    useEffect(() => {
      if (loadingState !== "assembling") {
        // If init bounced back to a picker, allow the next user selection to
        // start a fresh assembling phase.
        if (
          loadingState === "selecting" ||
          loadingState === "selecting_global" ||
          loadingState === "selecting_conversation"
        ) {
          initStartedRef.current = false;
        }
        return;
      }
      // Guard against double-fire from dependency churn in the same
      // "assembling" phase.  Only the first invocation should run.
      if (initStartedRef.current) return;
      initStartedRef.current = true;

      async function init() {
        markMilestone("TUI_INIT_START");
        const backend = getBackend();
        const startupBackendMode = backend.capabilities.localModelCatalog
          ? "local"
          : "api";

        // Determine which agent we'll be using (before loading tools)
        let resumingAgentId: string | null = null;
        // Track agent fetched during ID resolution so we can reuse it later
        // (validatedAgent React state may not be committed yet).
        let resolvedAgent: AgentState | null = null;

        // Fresh local-first startup may create the default agent during the
        // initial resolution phase. Carry it across explicitly instead of
        // depending on selectedGlobalAgentId state having committed in time.
        if (startupCreatedAgentRef.current) {
          resolvedAgent = startupCreatedAgentRef.current;
          resumingAgentId = startupCreatedAgentRef.current.id;
          startupCreatedAgentRef.current = null;
        }

        // Priority 1: --agent flag
        if (!resumingAgentId && agentIdArg) {
          // Use cached agent from name resolution if available
          if (validatedAgent && validatedAgent.id === agentIdArg) {
            resumingAgentId = agentIdArg;
          } else {
            try {
              const agent = await backend.retrieveAgent(agentIdArg, {
                include: ["agent.secrets", "agent.tools", "agent.tags"],
              });
              setValidatedAgent(agent);
              resolvedAgent = agent;
              resumingAgentId = agentIdArg;
            } catch {
              // Agent doesn't exist, will create new later
            }
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
          // Use cached agent from Phase 1 validation if available
          if (validatedAgent && validatedAgent.id === selectedGlobalAgentId) {
            resumingAgentId = selectedGlobalAgentId;
          } else {
            try {
              const agent = await backend.retrieveAgent(selectedGlobalAgentId, {
                include: ["agent.secrets", "agent.tools", "agent.tags"],
              });
              setValidatedAgent(agent);
              resolvedAgent = agent;
              resumingAgentId = selectedGlobalAgentId;
            } catch {
              // Selected agent doesn't exist - show selector again
              setLoadingState("selecting_global");
              return;
            }
          }
        }

        // Priority 3: LRU from the active backend (if not --new or user explicitly requested new from selector)
        if (!resumingAgentId && !shouldCreateNew) {
          const recentAgentId =
            startupBackendMode === "local"
              ? settingsManager.getLocalLastAgentId()
              : settingsManager.getGlobalLastAgentId();
          if (recentAgentId) {
            try {
              await backend.retrieveAgent(recentAgentId);
              resumingAgentId = recentAgentId;
            } catch {
              // LRU agent doesn't exist (wrong org, deleted, etc.)
              // Show selector instead of silently creating a new agent
              setLoadingState("selecting_global");
              return;
            }
          }
        }

        // Set resuming state early so loading messages are accurate
        setIsResumingSession(!!resumingAgentId);

        // Load an initial toolset for startup (explicit --toolset or model-derived).
        // App.tsx will reconcile persisted per-agent toolset preference after agent metadata loads.
        const modelForTools = getModelForToolLoading(
          model,
          toolset as "auto" | "codex" | "default" | "gemini" | undefined,
        );
        await loadTools(modelForTools);

        setLoadingState("initializing");
        const { createAgent } = await import("@/agent/create");

        let agent: AgentState | null = null;
        let autoEnableMemfsForFreshAgent = false;

        // Priority 1: Import from AgentFile template (local file or registry)
        if (fromAfFile) {
          setLoadingState("importing");
          let result: { agent: AgentState; skills?: string[] };

          if (isRegistryImport) {
            // Import from letta-ai/agent-file registry
            const { importAgentFromRegistry } = await import("@/agent/import");
            result = await importAgentFromRegistry({
              handle: fromAfFile,
              modelOverride: model,
              stripMessages: true,
              stripSkills: false,
            });
          } else {
            // Import from local file
            const { importAgentFromFile } = await import("@/agent/import");
            result = await importAgentFromFile({
              filePath: fromAfFile,
              modelOverride: model,
              stripMessages: true,
              stripSkills: false,
            });
          }

          agent = result.agent;
          setAgentProvenance({
            isNew: true,
            blocks: [],
          });

          // Mark imported agents as "custom" to prevent legacy auto-migration
          // from overwriting their system prompt on resume.
          if (settingsManager.isReady) {
            settingsManager.setSystemPromptCustom(agent.id);
          }

          // Display extracted skills summary
          if (result.skills && result.skills.length > 0) {
            const { getAgentSkillsDir } = await import("@/agent/skills");
            const skillsDir = getAgentSkillsDir(agent.id);
            console.log(
              `\n📦 Extracted ${result.skills.length} skill${result.skills.length === 1 ? "" : "s"} to ${skillsDir}: ${result.skills.join(", ")}\n`,
            );
          }
        }

        // Priority 2: Try to use --agent specified ID
        if (!agent && agentIdArg) {
          try {
            agent = await backend.retrieveAgent(agentIdArg, {
              include: ["agent.tags"],
            });
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
          // For custom API backends: if default model unavailable and no model selected yet, show picker
          if (availableServerModels.length > 0 && !selectedServerModel) {
            setLoadingState("selecting_global");
            return;
          }

          // Determine effective model:
          // 1. Use selectedServerModel if user picked from the custom-API picker
          // 2. Use model if --model flag was passed
          // 3. Otherwise, use billing-tier-aware default (free tier gets GLM-5)
          let effectiveModel = selectedServerModel || model;
          if (
            !effectiveModel &&
            !customApiBaseUrl &&
            !backend.capabilities.localModelCatalog
          ) {
            // On Letta API without explicit model - check billing tier for appropriate default
            const { getDefaultModelForTier } = await import("@/agent/model");
            const billingTier = await getBillingTier();
            effectiveModel = getDefaultModelForTier(billingTier);
          }

          // Pre-determine memfs mode so the agent is created with the correct prompt.
          const { isLettaCloud } = await import("@/agent/memory-filesystem");
          const willAutoEnableMemfs =
            shouldAutoEnableMemfsForNewAgent && (await isLettaCloud());
          const effectiveMemoryMode: MemoryPromptMode | undefined = backend
            .capabilities.localMemfs
            ? "local-memfs"
            : (requestedMemoryPromptMode ??
              (willAutoEnableMemfs ? "memfs" : undefined));

          const personalityOptions = personality
            ? await buildCreateAgentOptionsForPersonality({
                personalityId: personality,
                model: effectiveModel,
              })
            : undefined;
          const modelForUpdateArgs =
            personalityOptions?.model ?? effectiveModel;
          const baseUpdateArgs = getModelUpdateArgs(modelForUpdateArgs);
          const updateArgs = selectedServerModelReasoningEffort
            ? {
                ...(baseUpdateArgs ?? {}),
                reasoning_effort: selectedServerModelReasoningEffort,
              }
            : baseUpdateArgs;
          const result = await createAgent({
            ...(personalityOptions ?? {}),
            model: modelForUpdateArgs,
            updateArgs,
            skillsDirectory,
            parallelToolCalls: true,
            systemPromptPreset,
            systemPromptCustom: systemCustom,
            memoryPromptMode: effectiveMemoryMode,
            baseTools,
          });
          agent = result.agent;
          setAgentProvenance(result.provenance);
          autoEnableMemfsForFreshAgent = willAutoEnableMemfs;
        }

        // Priority 4: Try to resume from project settings LRU (.letta/settings.local.json)
        // Note: If LRU retrieval failed in early validation, we already showed selector and returned
        // Use cached agent from Phase 1 validation when available to avoid redundant API call
        if (!agent && resumingAgentId) {
          try {
            agent =
              resolvedAgent && resolvedAgent.id === resumingAgentId
                ? resolvedAgent
                : validatedAgent && validatedAgent.id === resumingAgentId
                  ? validatedAgent
                  : await backend.retrieveAgent(resumingAgentId, {
                      include: ["agent.tags"],
                    });
          } catch (error) {
            // Agent disappeared between validation and now - show selector
            console.error(
              `Agent ${resumingAgentId} not found (error: ${JSON.stringify(error)})`,
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

        // Set agent context for tools that need it (e.g., Skill tool)
        setAgentContext(
          agent.id,
          skillsDirectory,
          resolvedSkillSources,
          agent.name ?? null,
        );

        let startupMemfsFlag: boolean | undefined = autoEnableMemfsForFreshAgent
          ? true
          : memfsFlag;
        if (backend.capabilities.remoteMemfs && !autoEnableMemfsForFreshAgent) {
          const { hydrateMemfsSettingFromAgent, isLettaCloud } = await import(
            "@/agent/memory-filesystem"
          );
          const memfsEnabled = await hydrateMemfsSettingFromAgent(agent);
          if (!memfsEnabled) {
            if (await isLettaCloud()) {
              // Auto-enable memfs for existing agents that don't have it yet.
              // Agents can be created outside Letta Code without the tag.
              startupMemfsFlag = true;
            } else {
              console.warn(
                "Warning: this agent does not have git-backed memory enabled. Run `/memfs enable` to enable MemFS.",
              );
            }
          }
        }

        // Start memfs sync early. Interactive startup is optimistic: keep the
        // session moving and let memfs clone/pull finish in the background
        // unless the user explicitly requested a memfs mode toggle.
        const agentId = agent.id;
        const agentTags = agent.tags ?? undefined;
        const shouldBlockOnMemfsStartup = Boolean(memfsFlag);
        const memfsSyncPromise = backend.capabilities.remoteMemfs
          ? import("@/agent/memory-filesystem").then(({ applyMemfsFlags }) =>
              applyMemfsFlags(agentId, startupMemfsFlag, {
                pullOnExistingRepo: true,
                agentTags,
                skipPromptUpdate: shouldCreateNew,
              }),
            )
          : Promise.resolve().then(() => {
              if (backend.capabilities.localMemfs) {
                settingsManager.setMemfsEnabled(agentId, true);
                return { action: "enabled" };
              }
              if (memfsFlag) {
                throw new Error(
                  "MemFS is not supported by the active backend.",
                );
              }
              return null;
            });
        const memfsSyncBackgroundPromise = memfsSyncPromise.catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          debugWarn(
            "startup",
            `Background memfs sync failed for ${agentId}: ${message}`,
          );
          console.warn(`[memfs background sync] ${message}`);
          return null;
        });
        if (!shouldBlockOnMemfsStartup) {
          void memfsSyncBackgroundPromise;
        }

        // Init secrets cache — runs in parallel with memfs sync below.
        const secretsInitPromise = import("@/utils/secrets-store").then(
          ({ initSecretsFromServer }) =>
            initSecretsFromServer(agentId, agent ?? undefined),
        );

        // Check if we're resuming an existing agent
        // We're resuming if:
        // 1. We specified an agent ID via --agent flag (agentIdArg)
        // 2. We're reusing a project agent (detected early as resumingAgentId)
        // 3. We retrieved an agent from LRU (detected by checking if agent already existed)
        const isResumingProject = !shouldCreateNew && !!resumingAgentId;
        const isReusingExistingAgent =
          !shouldCreateNew && !fromAfFile && agent && agent.id;
        const resuming = !!(
          agentIdArg ||
          isResumingProject ||
          isReusingExistingAgent
        );
        setIsResumingSession(resuming);

        // If resuming, always refresh model settings from presets to keep
        // preset-derived fields in sync, then apply optional command-line
        // overrides (model/system prompt).
        if (resuming) {
          if (model) {
            const modelHandle = resolveModel(model);
            if (!modelHandle) {
              console.error(`Error: Invalid model "${model}"`);
              process.exit(1);
            }

            // Always apply model update - different model IDs can share the same
            // handle but have different settings (e.g., gpt-5.2-medium vs gpt-5.2-xhigh)
            const updateArgs = getModelUpdateArgs(model);
            agent = await updateAgentLLMConfig(
              agent.id,
              modelHandle,
              updateArgs,
            );
          } else {
            const presetRefresh = getModelPresetUpdateForAgent(agent);
            if (presetRefresh) {
              const { updateArgs: resumeRefreshUpdateArgs, needsUpdate } =
                getResumeRefreshArgs(presetRefresh.updateArgs, agent);

              if (needsUpdate) {
                // Resume refresh must not reset the context window; preserve
                // it by re-sending the agent's current value explicitly
                // (omitting it makes the server re-derive + clamp to a legacy
                // 128k default — LET-9786). A current value that looks like
                // that clamp is not preserved, letting the agent heal.
                const preservedContextWindow = preservableContextWindow(
                  agent.llm_config?.context_window,
                  presetRefresh.modelHandle,
                );
                agent = await updateAgentLLMConfig(
                  agent.id,
                  presetRefresh.modelHandle,
                  resumeRefreshUpdateArgs,
                  preservedContextWindow !== undefined
                    ? { contextWindowOverride: preservedContextWindow }
                    : undefined,
                );
              }
            }
          }

          if (systemPromptPreset) {
            // Rebuilding the prompt needs the reconciled memory mode so we
            // still wait here for this explicit override path.
            try {
              await memfsSyncPromise;
            } catch (error) {
              console.error(
                error instanceof Error ? error.message : String(error),
              );
              process.exit(1);
            }

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

        const startupAgentId = agent.id;
        void clearPersistedClientToolRules(startupAgentId, agent)
          .then((cleanup) => {
            if (cleanup) {
              const count = cleanup.removedToolNames.length;
              const names = cleanup.removedToolNames.join(", ");
              debugLog(
                "startup",
                `Cleared ${count} persisted client tool rule${count === 1 ? "" : "s"} for ${startupAgentId}${count > 0 ? `: ${names}` : ""}`,
              );
              return;
            }

            debugLog(
              "startup",
              `No persisted client tool rules to clear for ${startupAgentId}`,
            );
          })
          .catch((error) => {
            debugWarn(
              "startup",
              `Failed to clear persisted client tool rules for ${startupAgentId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });

        // Handle conversation: either resume existing or create new
        // Using definite assignment assertion - all branches below either set this or exit/throw
        let conversationIdToUse!: string;

        // Debug: log resume flag status
        if (isDebugEnabled()) {
          debugLog("startup", "shouldResume=%o", shouldResume);
          debugLog(
            "startup",
            "specifiedConversationId=%s",
            specifiedConversationId,
          );
        }

        if (specifiedConversationId) {
          // Use the explicitly specified conversation ID
          // User explicitly requested this conversation, so error if it doesn't exist
          conversationIdToUse = specifiedConversationId;
          setResumedExistingConversation(true);
          try {
            // Load message history and pending approvals from the conversation
            setLoadingState("checking");
            const data = await getResumeDataFromBackend(
              agent,
              specifiedConversationId,
            );
            setResumeData(data);
          } catch (error) {
            // Only treat 404/422 as "not found", rethrow other errors
            if (isBackendNotFoundError(error)) {
              console.error(
                `Conversation ${specifiedConversationId} not found`,
              );
              process.exit(1);
            }
            throw error;
          }
        } else if (selectedConversationId) {
          // Conversation selected from --resume selector or auto-restored from local project settings
          try {
            setLoadingState("checking");
            const data = await getResumeDataFromBackend(
              agent,
              selectedConversationId,
            );
            conversationIdToUse = selectedConversationId;
            setResumedExistingConversation(true);
            setResumeData(data);
          } catch (error) {
            if (isBackendNotFoundError(error)) {
              // Conversation no longer exists — fall back to default conversation
              console.warn(
                `Previous conversation ${selectedConversationId} not found, falling back to default`,
              );
              conversationIdToUse = "default";
              setLoadingState("checking");
              const data = await getResumeDataFromBackend(agent, "default");
              setResumeData(data);
              setResumedExistingConversation(data.messageHistory.length > 0);
            } else {
              throw error;
            }
          }
        } else if (forceNewConversation) {
          // --new flag: create a new conversation (for concurrent sessions)
          const conversation = await backend.createConversation({
            agent_id: agent.id,
          });
          conversationIdToUse = conversation.id;
        } else {
          // Default (including --new-agent): use the agent's "default" conversation
          conversationIdToUse = "default";

          // Load message history without waiting on memfs sync.
          setLoadingState("checking");
          const data = await getResumeDataFromBackend(agent, "default");
          setResumeData(data);
          setResumedExistingConversation(data.messageHistory.length > 0);
        }

        if (shouldBlockOnMemfsStartup) {
          try {
            await memfsSyncPromise;
          } catch (error) {
            console.error(
              error instanceof Error ? error.message : String(error),
            );
            process.exit(1);
          }
        }

        const fdPath = await ensureFdPath();
        setFileAutocompleteFdPath(fdPath);

        // Ensure secrets cache is populated (non-fatal).
        try {
          await secretsInitPromise;
        } catch (error) {
          import("@/utils/debug").then(({ debugLog }) =>
            debugLog(
              "secrets",
              `Failed to init secrets: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }

        // Save the session (agent + conversation) to settings
        // Skip for subagents - they shouldn't pollute the LRU settings
        if (shouldPersistSessionState()) {
          settingsManager.persistSession(agent.id, conversationIdToUse);
        }

        setAgentId(agent.id);
        setAgentState(agent);
        setConversationId(conversationIdToUse);
        // Also set in global context for tools (e.g., Skill tool) to access
        setContextConversationId(conversationIdToUse);
        markMilestone("TUI_READY");
        setLoadingState("ready");

        // Maintain managed system prompt versions without blocking startup.
        // This updates only agents whose current prompt still matches the
        // stored managed prompt hash, so custom edits are preserved.
        if (resuming && !systemPromptPreset) {
          const {
            ensureLettaCodeOriginTag,
            getMemoryPromptModeForAgent,
            scheduleManagedSystemPromptUpdate,
          } = await import("@/agent/system-prompt-versioning");
          void ensureLettaCodeOriginTag(agent)
            .catch((error) => {
              import("@/utils/debug").then(({ debugWarn }) =>
                debugWarn(
                  "startup",
                  `Failed to ensure Letta Code origin tag for ${agent.id}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
              return agent;
            })
            .then((taggedAgent) => {
              setAgentState(taggedAgent);
              scheduleManagedSystemPromptUpdate({
                agent: taggedAgent,
                memoryMode: getMemoryPromptModeForAgent(taggedAgent.id),
                onUpdated: (updatedAgent) => {
                  setAgentState(updatedAgent);
                },
              });
            });
        }
      }

      init().catch((err) => {
        // Handle errors gracefully without showing raw stack traces
        trackCliBoundaryError(
          "tui_initialization_failed",
          err,
          "tui_app_initialization",
        );
        const message = formatErrorDetails(err);
        console.error(`\nError during initialization: ${message}`);
        if (isDebugEnabled()) {
          console.error(err);
        }
        process.exit(1);
      });
    }, [
      forceNew,
      userRequestedNewAgent,
      agentIdArg,
      model,
      systemPromptPreset,
      fromAfFile,
      loadingState,
      selectedGlobalAgentId,
      validatedAgent,
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
        // For custom API backends: pass available models so user can pick one when creating new agent
        serverModelsForNewAgent:
          availableServerModels.length > 0 ? availableServerModels : undefined,
        defaultModelHandle: customApiDefaultModel ?? undefined,
        serverBaseUrl: customApiBaseUrl ?? undefined,
        onSelect: (agentId: string) => {
          setSelectedGlobalAgentId(agentId);
          setLoadingState("assembling");
        },
        onCreateNew: () => {
          setUserRequestedNewAgent(true);
          setLoadingState("assembling");
        },
        onCreateNewWithModel: (
          modelHandle: string,
          reasoningEffort?: ModelReasoningEffort,
        ) => {
          setUserRequestedNewAgent(true);
          setSelectedServerModel(modelHandle);
          setSelectedServerModelReasoningEffort(reasoningEffort ?? null);
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
        reasoningTabCycleEnabled: settings.reasoningTabCycleEnabled === true,
        showCompactions: settings.showCompactions,
        agentProvenance,
        startupHasCloudCredentials,
        startupHasAvailableLocalModels,
        releaseNotes,
        systemInfoReminderEnabled: !noSystemInfoReminderFlag,
        modsDisabled,
        fileAutocompleteFdPath,
      });
    }

    return React.createElement(App, {
      key: `${agentId}:${conversationId}`,
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
      reasoningTabCycleEnabled: settings.reasoningTabCycleEnabled === true,
      showCompactions: settings.showCompactions,
      agentProvenance,
      startupHasCloudCredentials,
      startupHasAvailableLocalModels,
      releaseNotes,
      updateNotification,
      systemInfoReminderEnabled: !noSystemInfoReminderFlag,
      modsDisabled,
      fileAutocompleteFdPath,
    });
  }

  markMilestone("REACT_RENDER_START");
  render(
    React.createElement(LoadingApp, {
      forceNew: forceNew,
      baseTools: baseTools,
      agentIdArg: specifiedAgentId,
      preResolvedAgent: nameResolvedAgent,
      model: specifiedModel,
      systemPromptPreset: systemPromptPreset,
      toolset: specifiedToolset as
        | "auto"
        | "codex"
        | "default"
        | "gemini"
        | undefined,
      skillsDirectory: skillsDirectory,
      fromAfFile: fromAfFile,
      isRegistryImport: isRegistryImport,
    }),
    {
      exitOnCtrlC: false, // We handle CTRL-C manually with double-press guard
    },
  );
}

main();
