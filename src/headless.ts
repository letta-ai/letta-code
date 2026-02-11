import { parseArgs } from "node:util";
import type { Letta } from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { ApprovalResult } from "./agent/approval-execution";
import {
  fetchRunErrorDetail,
  getPreStreamErrorAction,
  isApprovalPendingError,
  isInvalidToolCallIdsError,
} from "./agent/approval-recovery";
import { getClient } from "./agent/client";
import { setAgentContext, setConversationId } from "./agent/context";
import { createAgent } from "./agent/create";
import { ISOLATED_BLOCK_LABELS } from "./agent/memory";

import { sendMessageStream } from "./agent/message";
import { getModelUpdateArgs } from "./agent/model";
import { SessionStats } from "./agent/stats";
import {
  createBuffers,
  type Line,
  markIncompleteToolsAsCancelled,
  toLines,
} from "./cli/helpers/accumulator";
import { classifyApprovals } from "./cli/helpers/approvalClassification";
import { formatErrorDetails } from "./cli/helpers/errorFormatter";
import {
  type DrainStreamHook,
  drainStreamWithResume,
} from "./cli/helpers/stream";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "./constants";
import { settingsManager } from "./settings-manager";
import {
  isHeadlessAutoAllowTool,
  isInteractiveApprovalTool,
} from "./tools/interactivePolicy";
import {
  type ExternalToolDefinition,
  registerExternalTools,
  setExternalToolExecutor,
} from "./tools/manager";
import type {
  AutoApprovalMessage,
  CanUseToolControlRequest,
  CanUseToolResponse,
  ControlRequest,
  ControlResponse,
  ErrorMessage,
  MessageWire,
  RecoveryMessage,
  ResultMessage,
  RetryMessage,
  StreamEvent,
  SystemInitMessage,
} from "./types/protocol";
import {
  markMilestone,
  measureSinceMilestone,
  reportAllMilestones,
} from "./utils/timing";

// Maximum number of times to retry a turn when the backend
// reports an `llm_api_error` stop reason. This helps smooth
// over transient LLM/backend issues without requiring the
// caller to manually resubmit the prompt.
const LLM_API_ERROR_MAX_RETRIES = 3;

// Retry config for 409 "conversation busy" errors
const CONVERSATION_BUSY_MAX_RETRIES = 1; // Only retry once, fail on 2nd 409
const CONVERSATION_BUSY_RETRY_DELAY_MS = 2500; // 2.5 seconds

export async function handleHeadlessCommand(
  argv: string[],
  model?: string,
  skillsDirectory?: string,
) {
  const settings = settingsManager.getSettings();

  // Parse CLI args
  // Include all flags from index.ts to prevent them from being treated as positionals
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      // Flags used in headless mode
      continue: { type: "boolean", short: "c" },
      resume: { type: "boolean", short: "r" },
      conversation: { type: "string" },
      default: { type: "boolean" }, // Alias for --conv default
      "new-agent": { type: "boolean" },
      new: { type: "boolean" }, // Deprecated - kept for helpful error message
      agent: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
      embedding: { type: "string" },
      system: { type: "string", short: "s" },
      "system-custom": { type: "string" },
      "system-append": { type: "string" },
      "memory-blocks": { type: "string" },
      "block-value": { type: "string", multiple: true },
      toolset: { type: "string" },
      prompt: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      "input-format": { type: "string" },
      "include-partial-messages": { type: "boolean" },
      "from-agent": { type: "string" },
      // Additional flags from index.ts that need to be filtered out
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      run: { type: "boolean" },
      tools: { type: "string" },
      allowedTools: { type: "string" },
      disallowedTools: { type: "string" },
      "permission-mode": { type: "string" },
      yolo: { type: "boolean" },
      skills: { type: "string" },
      sleeptime: { type: "boolean" },
      "init-blocks": { type: "string" },
      "base-tools": { type: "string" },
      "from-af": { type: "string" },

      memfs: { type: "boolean" },
      "no-memfs": { type: "boolean" },
      "max-turns": { type: "string" }, // Maximum number of agentic turns
    },
    strict: false,
    allowPositionals: true,
  });

  // Set tool filter if provided (controls which tools are loaded)
  if (values.tools !== undefined) {
    const { toolFilter } = await import("./tools/filter");
    toolFilter.setEnabledTools(values.tools as string);
  }
  // Set permission mode if provided (or via --yolo alias)
  const permissionModeValue = values["permission-mode"] as string | undefined;
  const yoloMode = values.yolo as boolean | undefined;
  if (yoloMode || permissionModeValue) {
    const { permissionMode } = await import("./permissions/mode");
    if (yoloMode) {
      permissionMode.setMode("bypassPermissions");
    } else if (permissionModeValue) {
      const validModes = [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
      ];
      if (validModes.includes(permissionModeValue)) {
        permissionMode.setMode(
          permissionModeValue as
            | "default"
            | "acceptEdits"
            | "bypassPermissions"
            | "plan",
        );
      }
    }
  }

  // Set CLI permission overrides if provided (inherited from parent agent)
  if (values.allowedTools || values.disallowedTools) {
    const { cliPermissions } = await import("./permissions/cli");
    if (values.allowedTools) {
      cliPermissions.setAllowedTools(values.allowedTools as string);
    }
    if (values.disallowedTools) {
      cliPermissions.setDisallowedTools(values.disallowedTools as string);
    }
  }

  // Check for input-format early - if stream-json, we don't need a prompt
  const inputFormat = values["input-format"] as string | undefined;
  const isBidirectionalMode = inputFormat === "stream-json";

  // If headless output is being piped and the downstream closes early (e.g.
  // `| head`), Node will throw EPIPE on stdout writes. Treat this as a normal
  // termination rather than crashing with a stack trace.
  //
  // Note: this must be registered before any `console.log` in headless mode.
  process.stdout.on("error", (err: unknown) => {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;

    if (code === "EPIPE") {
      process.exit(0);
    }

    // Re-throw unknown stdout errors so they surface during tests/debugging.
    throw err;
  });

  // Get prompt from either positional args or stdin (unless in bidirectional mode)
  let prompt = positionals.slice(2).join(" ");

  // If no prompt provided as args, try reading from stdin (unless in bidirectional mode)
  if (!prompt && !isBidirectionalMode) {
    // Check if stdin is available (piped input)
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      prompt = Buffer.concat(chunks).toString("utf-8").trim();
    }
  }

  if (!prompt && !isBidirectionalMode) {
    console.error("Error: No prompt provided");
    process.exit(1);
  }

  const client = await getClient();
  markMilestone("HEADLESS_CLIENT_READY");

  // Check for --resume flag (interactive only)
  if (values.resume) {
    console.error(
      "Error: --resume is for interactive mode only (opens conversation selector).\n" +
        "In headless mode, use:\n" +
        "  --continue           Resume the last session (agent + conversation)\n" +
        "  --conversation <id>  Resume a specific conversation by ID",
    );
    process.exit(1);
  }

  // --new: Create a new conversation (for concurrent sessions)
  let forceNewConversation = (values.new as boolean | undefined) ?? false;
  const fromAgentId = values["from-agent"] as string | undefined;

  // Resolve agent (same logic as interactive mode)
  let agent: AgentState | null = null;
  let isNewlyCreatedAgent = false;
  let specifiedAgentId = values.agent as string | undefined;
  let specifiedConversationId = values.conversation as string | undefined;
  const useDefaultConv = values.default as boolean | undefined;
  const shouldContinue = values.continue as boolean | undefined;
  const forceNew = values["new-agent"] as boolean | undefined;

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
  const systemPromptPreset = values.system as string | undefined;
  const systemCustom = values["system-custom"] as string | undefined;
  const systemAppend = values["system-append"] as string | undefined;
  const embeddingModel = values.embedding as string | undefined;
  const memoryBlocksJson = values["memory-blocks"] as string | undefined;
  const blockValueArgs = values["block-value"] as string[] | undefined;
  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  const sleeptimeFlag = (values.sleeptime as boolean | undefined) ?? undefined;
  const memfsFlag = values.memfs as boolean | undefined;
  const noMemfsFlag = values["no-memfs"] as boolean | undefined;
  const fromAfFile = values["from-af"] as string | undefined;
  const maxTurnsRaw = values["max-turns"] as string | undefined;

  // Parse and validate max-turns if provided
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    const parsed = parseInt(maxTurnsRaw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.error(
        `Error: --max-turns must be a positive integer, got: ${maxTurnsRaw}`,
      );
      process.exit(1);
    }
    maxTurns = parsed;
  }

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

  if (fromAgentId) {
    if (!specifiedAgentId && !specifiedConversationId) {
      console.error(
        "Error: --from-agent requires --agent <id> or --conversation <id>.",
      );
      process.exit(1);
    }
    if (shouldContinue) {
      console.error("Error: --from-agent cannot be used with --continue");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --from-agent cannot be used with --new-agent");
      process.exit(1);
    }
    if (!specifiedConversationId && !forceNewConversation) {
      forceNewConversation = true;
    }
  }

  // Validate --conversation flag (mutually exclusive with agent-selection flags)
  // Exception: --conv default requires --agent
  if (specifiedConversationId && specifiedConversationId !== "default") {
    if (specifiedAgentId) {
      console.error("Error: --conversation cannot be used with --agent");
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
  }

  // Validate --from-af flag
  // Detect if it's a registry handle (e.g., @author/name) or a local file path
  let isRegistryImport = false;
  if (fromAfFile) {
    if (specifiedAgentId) {
      console.error("Error: --from-af cannot be used with --agent");
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

    // Check if this looks like a registry handle (@author/name)
    if (fromAfFile.startsWith("@")) {
      // Definitely a registry handle
      isRegistryImport = true;
      // Validate handle format
      const normalized = fromAfFile.slice(1);
      const parts = normalized.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        console.error(
          `Error: Invalid registry handle "${fromAfFile}". Use format: @author/agentname`,
        );
        process.exit(1);
      }
    }
  }

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
      initBlocks = [];
    } else {
      initBlocks = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

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

  // Validate system prompt options (--system and --system-custom are mutually exclusive)
  if (systemPromptPreset && systemCustom) {
    console.error(
      "Error: --system and --system-custom are mutually exclusive. Use one or the other.",
    );
    process.exit(1);
  }

  // Parse memory blocks JSON if provided
  // Supports two formats:
  // - CreateBlock: { label: string, value: string, description?: string }
  // - BlockReference: { blockId: string }
  let memoryBlocks:
    | Array<
        | { label: string; value: string; description?: string }
        | { blockId: string }
      >
    | undefined;
  if (memoryBlocksJson !== undefined) {
    if (!forceNew) {
      console.error(
        "Error: --memory-blocks can only be used together with --new to provide initial memory blocks.",
      );
      process.exit(1);
    }
    try {
      memoryBlocks = JSON.parse(memoryBlocksJson);
      if (!Array.isArray(memoryBlocks)) {
        throw new Error("memory-blocks must be a JSON array");
      }
      // Validate each block has required fields
      for (const block of memoryBlocks) {
        const hasBlockId =
          "blockId" in block && typeof block.blockId === "string";
        const hasLabelValue =
          "label" in block &&
          "value" in block &&
          typeof block.label === "string" &&
          typeof block.value === "string";

        if (!hasBlockId && !hasLabelValue) {
          throw new Error(
            "Each memory block must have either 'blockId' (string) or 'label' and 'value' (strings)",
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

  // Parse --block-value args (format: label=value)
  let blockValues: Record<string, string> | undefined;
  if (blockValueArgs && blockValueArgs.length > 0) {
    if (!forceNew) {
      console.error(
        "Error: --block-value can only be used together with --new to set block values.",
      );
      process.exit(1);
    }
    blockValues = {};
    for (const arg of blockValueArgs) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex === -1) {
        console.error(
          `Error: Invalid --block-value format "${arg}". Expected format: label=value`,
        );
        process.exit(1);
      }
      const label = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      blockValues[label] = value;
    }
  }

  // Priority 0: --conversation derives agent from conversation ID
  if (specifiedConversationId) {
    try {
      const conversation = await client.conversations.retrieve(
        specifiedConversationId,
      );
      agent = await client.agents.retrieve(conversation.agent_id);
    } catch (_error) {
      console.error(`Conversation ${specifiedConversationId} not found`);
      process.exit(1);
    }
  }

  // Priority 1: Import from AgentFile template (local file or registry)
  if (!agent && fromAfFile) {
    let result: { agent: AgentState; skills?: string[] };

    if (isRegistryImport) {
      // Import from letta-ai/agent-file registry
      const { importAgentFromRegistry } = await import("./agent/import");
      result = await importAgentFromRegistry({
        handle: fromAfFile,
        modelOverride: model,
        stripMessages: true,
        stripSkills: false,
      });
    } else {
      // Import from local file
      const { importAgentFromFile } = await import("./agent/import");
      result = await importAgentFromFile({
        filePath: fromAfFile,
        modelOverride: model,
        stripMessages: true,
        stripSkills: false,
      });
    }

    agent = result.agent;
    isNewlyCreatedAgent = true;

    // Display extracted skills summary
    if (result.skills && result.skills.length > 0) {
      const { getAgentSkillsDir } = await import("./agent/skills");
      const skillsDir = getAgentSkillsDir(agent.id);
      console.log(
        `📦 Extracted ${result.skills.length} skill${result.skills.length === 1 ? "" : "s"} to ${skillsDir}: ${result.skills.join(", ")}`,
      );
    }
  }

  // Priority 2: Try to use --agent specified ID
  if (!agent && specifiedAgentId) {
    try {
      agent = await client.agents.retrieve(specifiedAgentId);
    } catch (_error) {
      console.error(`Agent ${specifiedAgentId} not found`);
      process.exit(1);
    }
  }

  // Priority 3: Check if --new flag was passed (skip all resume logic)
  if (!agent && forceNew) {
    const updateArgs = getModelUpdateArgs(model);
    const createOptions = {
      model,
      embeddingModel,
      updateArgs,
      skillsDirectory,
      parallelToolCalls: true,
      enableSleeptime: sleeptimeFlag ?? settings.enableSleeptime,
      systemPromptPreset,
      systemPromptCustom: systemCustom,
      systemPromptAppend: systemAppend,
      initBlocks,
      baseTools,
      memoryBlocks,
      blockValues,
    };
    const result = await createAgent(createOptions);
    agent = result.agent;
    isNewlyCreatedAgent = true;
  }

  // Priority 4: Try to resume from project settings (.letta/settings.local.json)
  if (!agent) {
    await settingsManager.loadLocalProjectSettings();
    const localProjectSettings = settingsManager.getLocalProjectSettings();
    if (localProjectSettings?.lastAgent) {
      try {
        agent = await client.agents.retrieve(localProjectSettings.lastAgent);
      } catch (_error) {
        // Local LRU agent doesn't exist - log and continue
        console.error(
          `Unable to locate agent ${localProjectSettings.lastAgent} in .letta/`,
        );
      }
    }
  }

  // Priority 5: Try to reuse global lastAgent if --continue flag is passed
  if (!agent && shouldContinue) {
    if (settings.lastAgent) {
      try {
        agent = await client.agents.retrieve(settings.lastAgent);
      } catch (_error) {
        // Global LRU agent doesn't exist
      }
    }
    // --continue requires an LRU agent to exist
    if (!agent) {
      console.error("No recent session found in .letta/ or ~/.letta.");
      console.error("Run 'letta' to get started.");
      process.exit(1);
    }
  }

  // Priority 6: Fresh user with no LRU - create Memo (same as interactive mode)
  if (!agent) {
    const { ensureDefaultAgents } = await import("./agent/defaults");
    const memoAgent = await ensureDefaultAgents(client);
    if (memoAgent) {
      agent = memoAgent;
    }
  }

  // All paths should have resolved to an agent by now
  if (!agent) {
    console.error("No agent found. Use --new-agent to create a new agent.");
    process.exit(1);
  }
  markMilestone("HEADLESS_AGENT_RESOLVED");

  // Check if we're resuming an existing agent (not creating a new one)
  const isResumingAgent = !!(
    specifiedAgentId ||
    shouldContinue ||
    (!forceNew && !fromAfFile)
  );

  // If resuming and a model or system prompt was specified, apply those changes
  if (isResumingAgent && (model || systemPromptPreset)) {
    if (model) {
      const { resolveModel } = await import("./agent/model");
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
        console.error(`Failed to update system prompt: ${result.message}`);
        process.exit(1);
      }
      agent = result.agent;
    }
  }

  // Determine which conversation to use
  let conversationId: string;

  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";

  // Apply memfs flag if specified, or enable by default for new agents
  if (memfsFlag) {
    settingsManager.setMemfsEnabled(agent.id, true);
  } else if (noMemfsFlag) {
    settingsManager.setMemfsEnabled(agent.id, false);
  } else if (isNewlyCreatedAgent && !isSubagent) {
    // Enable memfs by default for newly created agents (but not subagents)
    settingsManager.setMemfsEnabled(agent.id, true);
  }

  // Ensure agent's system prompt includes/excludes memfs section to match setting
  if (memfsFlag || noMemfsFlag || (isNewlyCreatedAgent && !isSubagent)) {
    const { updateAgentSystemPromptMemfs } = await import("./agent/modify");
    await updateAgentSystemPromptMemfs(
      agent.id,
      settingsManager.isMemfsEnabled(agent.id),
    );
  }

  // Git-backed memory: clone or pull on startup (only if memfs is enabled)
  if (settingsManager.isMemfsEnabled(agent.id)) {
    try {
      const { isGitRepo, cloneMemoryRepo, pullMemory } = await import(
        "./agent/memoryGit"
      );
      if (!isGitRepo(agent.id)) {
        await cloneMemoryRepo(agent.id);
      } else {
        const result = await pullMemory(agent.id);
        if (result.summary.includes("CONFLICT")) {
          console.error(
            "Memory has merge conflicts. Run in interactive mode to resolve.",
          );
          process.exit(1);
        }
      }
    } catch (error) {
      console.error(
        `Memory git sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Determine which blocks to isolate for the conversation
  const isolatedBlockLabels: string[] =
    initBlocks === undefined
      ? [...ISOLATED_BLOCK_LABELS]
      : ISOLATED_BLOCK_LABELS.filter((label) =>
          initBlocks.includes(label as string),
        );

  if (specifiedConversationId) {
    if (specifiedConversationId === "default") {
      // "default" is the agent's primary message history (no explicit conversation)
      // Don't validate - just use it directly
      conversationId = "default";
    } else {
      // User specified an explicit conversation to resume - validate it exists
      try {
        await client.conversations.retrieve(specifiedConversationId);
        conversationId = specifiedConversationId;
      } catch {
        console.error(
          `Error: Conversation ${specifiedConversationId} not found`,
        );
        process.exit(1);
      }
    }
  } else if (shouldContinue) {
    // Try to resume the last conversation for this agent
    await settingsManager.loadLocalProjectSettings();
    const lastSession =
      settingsManager.getLocalLastSession(process.cwd()) ??
      settingsManager.getGlobalLastSession();

    if (lastSession && lastSession.agentId === agent.id) {
      if (lastSession.conversationId === "default") {
        // "default" is always valid - just use it directly
        conversationId = "default";
      } else {
        // Verify the conversation still exists
        try {
          await client.conversations.retrieve(lastSession.conversationId);
          conversationId = lastSession.conversationId;
        } catch {
          // Conversation no longer exists - error with helpful message
          console.error(
            `Attempting to resume conversation ${lastSession.conversationId}, but conversation was not found.`,
          );
          console.error(
            "Resume the default conversation with 'letta -p ...', view recent conversations with 'letta --resume', or start a new conversation with 'letta -p ... --new'.",
          );
          process.exit(1);
        }
      }
    } else {
      // No matching session - error with helpful message
      console.error("No previous session found for this agent to resume.");
      console.error(
        "Resume the default conversation with 'letta -p ...', or start a new conversation with 'letta -p ... --new'.",
      );
      process.exit(1);
    }
  } else if (forceNewConversation) {
    // --new flag: create a new conversation (for concurrent sessions)
    const conversation = await client.conversations.create({
      agent_id: agent.id,
      isolated_block_labels: isolatedBlockLabels,
    });
    conversationId = conversation.id;
  } else {
    // Default (including --new-agent, --agent): use the agent's "default" conversation
    conversationId = "default";
  }
  markMilestone("HEADLESS_CONVERSATION_READY");

  // Set conversation ID in context for tools (e.g., Skill tool) to access
  setConversationId(conversationId);

  // Save session (agent + conversation) to both project and global settings
  // Skip for subagents - they shouldn't pollute the LRU settings
  if (!isSubagent) {
    await settingsManager.loadLocalProjectSettings();
    settingsManager.setLocalLastSession(
      { agentId: agent.id, conversationId },
      process.cwd(),
    );
    settingsManager.setGlobalLastSession({
      agentId: agent.id,
      conversationId,
    });
  }

  // Migration (LET-7353): Remove legacy skills/loaded_skills blocks
  for (const label of ["skills", "loaded_skills"]) {
    try {
      const block = await client.agents.blocks.retrieve(label, {
        agent_id: agent.id,
      });
      if (block) {
        await client.agents.blocks.detach(block.id, {
          agent_id: agent.id,
        });
        await client.blocks.delete(block.id);
      }
    } catch {
      // Block doesn't exist or already removed, skip
    }
  }

  // Set agent context for tools that need it (e.g., Skill tool, Task tool)
  setAgentContext(agent.id, skillsDirectory);

  // Validate output format
  const outputFormat =
    (values["output-format"] as string | undefined) || "text";
  const includePartialMessages = Boolean(values["include-partial-messages"]);
  if (!["text", "json", "stream-json"].includes(outputFormat)) {
    console.error(
      `Error: Invalid output format "${outputFormat}". Valid formats: text, json, stream-json`,
    );
    process.exit(1);
  }
  if (inputFormat && inputFormat !== "stream-json") {
    console.error(
      `Error: Invalid input format "${inputFormat}". Valid formats: stream-json`,
    );
    process.exit(1);
  }

  const { getClientToolsFromRegistry } = await import("./tools/manager");
  const loadedToolNames = getClientToolsFromRegistry().map((t) => t.name);
  const availableTools =
    loadedToolNames.length > 0
      ? loadedToolNames
      : agent.tools?.map((t) => t.name).filter((n): n is string => !!n) || [];

  // If input-format is stream-json, use bidirectional mode
  if (isBidirectionalMode) {
    await runBidirectionalMode(
      agent,
      conversationId,
      client,
      outputFormat,
      includePartialMessages,
      availableTools,
    );
    return;
  }

  // Create buffers to accumulate stream (pass agent.id for server-side tool hooks)
  const buffers = createBuffers(agent.id);

  // Initialize session stats
  const sessionStats = new SessionStats();

  // Use agent.id as session_id for all stream-json messages
  const sessionId = agent.id;

  // Output init event for stream-json format
  if (outputFormat === "stream-json") {
    const initEvent: SystemInitMessage = {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      agent_id: agent.id,
      conversation_id: conversationId,
      model: agent.llm_config?.model ?? "",
      tools: availableTools,
      cwd: process.cwd(),
      mcp_servers: [],
      permission_mode: "",
      slash_commands: [],
      uuid: `init-${agent.id}`,
    };
    console.log(JSON.stringify(initEvent));
  }

  // Helper to resolve any pending approvals before sending user input
  const resolveAllPendingApprovals = async () => {
    const { getResumeData } = await import("./agent/check-approval");
    while (true) {
      // Re-fetch agent to get latest in-context messages (source of truth for backend)
      const freshAgent = await client.agents.retrieve(agent.id);

      let resume: Awaited<ReturnType<typeof getResumeData>>;
      try {
        resume = await getResumeData(client, freshAgent, conversationId);
      } catch (error) {
        // Treat 404/422 as "no approvals" - stale message/conversation state
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 422)
        ) {
          break;
        }
        throw error;
      }

      // Use plural field for parallel tool calls
      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) break;

      // Phase 1: Collect decisions for all approvals
      type Decision =
        | {
            type: "approve";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
            matchedRule: string;
          }
        | {
            type: "deny";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
          };

      const { autoAllowed, autoDenied } = await classifyApprovals(
        pendingApprovals,
        {
          alwaysRequiresUserInput: isInteractiveApprovalTool,
          treatAskAsDeny: true,
          denyReasonForAsk: "Tool requires approval (headless mode)",
          requireArgsForAutoApprove: true,
          missingNameReason: "Tool call incomplete - missing name",
        },
      );

      const decisions: Decision[] = [
        ...autoAllowed.map((ac) => ({
          type: "approve" as const,
          approval: ac.approval,
          reason: ac.permission.reason || "Allowed by permission rule",
          matchedRule:
            "matchedRule" in ac.permission && ac.permission.matchedRule
              ? ac.permission.matchedRule
              : "auto-approved",
        })),
        ...autoDenied.map((ac) => {
          const fallback =
            "matchedRule" in ac.permission && ac.permission.matchedRule
              ? `Permission denied: ${ac.permission.matchedRule}`
              : ac.permission.reason
                ? `Permission denied: ${ac.permission.reason}`
                : "Permission denied: Unknown reason";
          return {
            type: "deny" as const,
            approval: ac.approval,
            reason: ac.denyReason ?? fallback,
          };
        }),
      ];

      // Phase 2: Execute approved tools and format results using shared function
      const { executeApprovalBatch } = await import(
        "./agent/approval-execution"
      );

      // Emit auto_approval events for stream-json format
      if (outputFormat === "stream-json") {
        for (const decision of decisions) {
          if (decision.type === "approve") {
            const autoApprovalMsg: AutoApprovalMessage = {
              type: "auto_approval",
              tool_call: {
                name: decision.approval.toolName,
                tool_call_id: decision.approval.toolCallId,
                arguments: decision.approval.toolArgs,
              },
              reason: decision.reason,
              matched_rule: decision.matchedRule,
              session_id: sessionId,
              uuid: `auto-approval-${decision.approval.toolCallId}`,
            };
            console.log(JSON.stringify(autoApprovalMsg));
          }
        }
      }

      const executedResults = await executeApprovalBatch(decisions);

      // Send all results in one batch
      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: executedResults as ApprovalResult[],
      };

      // Inject queued skill content as user message parts (LET-7353)
      const approvalMessages: Array<
        | import("@letta-ai/letta-client/resources/agents/agents").MessageCreate
        | import("@letta-ai/letta-client/resources/agents/messages").ApprovalCreate
      > = [approvalInput];
      {
        const { consumeQueuedSkillContent } = await import(
          "./tools/impl/skillContentRegistry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          approvalMessages.push({
            role: "user" as const,
            content: skillContents.map((sc) => ({
              type: "text" as const,
              text: sc.content,
            })),
          });
        }
      }

      // Send the approval to clear the pending state; drain the stream without output
      const approvalStream = await sendMessageStream(
        conversationId,
        approvalMessages,
        { agentId: agent.id },
      );
      if (outputFormat === "stream-json") {
        // Consume quickly but don't emit message frames to stdout
        for await (const _ of approvalStream) {
          // no-op
        }
      } else {
        await drainStreamWithResume(
          approvalStream,
          createBuffers(agent.id),
          () => {},
        );
      }
    }
  };

  // Clear any pending approvals before starting a new turn - ONLY when resuming (LET-7101)
  // For new agents/conversations, lazy recovery handles any edge cases
  if (isResumingAgent) {
    await resolveAllPendingApprovals();
  }

  // Build message content with reminders
  const { permissionMode } = await import("./permissions/mode");
  const contentParts: MessageCreate["content"] = [];
  const pushPart = (text: string) => {
    if (!text) return;
    contentParts.push({ type: "text", text });
  };

  if (fromAgentId) {
    const senderAgentId = fromAgentId;
    const senderAgent = await client.agents.retrieve(senderAgentId);
    const systemReminder = `${SYSTEM_REMINDER_OPEN}
This message is from "${senderAgent.name}" (agent ID: ${senderAgentId}), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
${SYSTEM_REMINDER_CLOSE}

`;
    pushPart(systemReminder);
  }

  // Inject available skills as system-reminder (LET-7353)
  {
    const {
      discoverSkills,
      SKILLS_DIR: defaultDir,
      formatSkillsAsSystemReminder,
    } = await import("./agent/skills");
    const { getSkillsDirectory } = await import("./agent/context");
    const { join } = await import("node:path");
    try {
      const skillsDir = getSkillsDirectory() || join(process.cwd(), defaultDir);
      const { skills } = await discoverSkills(skillsDir, agent.id);
      const skillsReminder = formatSkillsAsSystemReminder(skills);
      if (skillsReminder) {
        pushPart(skillsReminder);
      }
    } catch {
      // Skills discovery failed, skip
    }
  }

  // Add plan mode reminder if in plan mode (highest priority)
  if (permissionMode.getMode() === "plan") {
    const { PLAN_MODE_REMINDER } = await import("./agent/promptAssets");
    pushPart(PLAN_MODE_REMINDER);
  }

  // Add user prompt
  pushPart(prompt);

  // Start with the user message
  let currentInput: Array<MessageCreate | ApprovalCreate> = [
    {
      role: "user",
      content: contentParts,
    },
  ];

  // Track lastRunId outside the while loop so it's available in catch block
  let lastKnownRunId: string | null = null;
  let llmApiErrorRetries = 0;
  let conversationBusyRetries = 0;
  markMilestone("HEADLESS_FIRST_STREAM_START");
  measureSinceMilestone("headless-setup-total", "HEADLESS_CLIENT_READY");

  // Helper to check max turns limit using server-side step count from buffers
  const checkMaxTurns = () => {
    if (maxTurns !== undefined && buffers.usage.stepCount >= maxTurns) {
      if (outputFormat === "stream-json") {
        const errorMsg: ErrorMessage = {
          type: "error",
          message: `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`,
          stop_reason: "max_steps",
          session_id: sessionId,
          uuid: `error-max-turns-${crypto.randomUUID()}`,
        };
        console.log(JSON.stringify(errorMsg));
      } else {
        console.error(
          `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`,
        );
      }
      process.exit(1);
    }
  };

  try {
    while (true) {
      // Check max turns limit before starting a new turn (uses server-side step count)
      checkMaxTurns();

      // Inject queued skill content as user message parts (LET-7353)
      {
        const { consumeQueuedSkillContent } = await import(
          "./tools/impl/skillContentRegistry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          currentInput = [
            ...currentInput,
            {
              role: "user" as const,
              content: skillContents.map((sc) => ({
                type: "text" as const,
                text: sc.content,
              })),
            },
          ];
        }
      }

      // Wrap sendMessageStream in try-catch to handle pre-stream errors (e.g., 409)
      let stream: Awaited<ReturnType<typeof sendMessageStream>>;
      try {
        stream = await sendMessageStream(conversationId, currentInput, {
          agentId: agent.id,
        });
      } catch (preStreamError) {
        // Extract error detail from APIError
        let errorDetail = "";
        if (
          preStreamError instanceof APIError &&
          preStreamError.error &&
          typeof preStreamError.error === "object"
        ) {
          const errObj = preStreamError.error as Record<string, unknown>;
          if (
            errObj.error &&
            typeof errObj.error === "object" &&
            "detail" in errObj.error
          ) {
            const nested = errObj.error as Record<string, unknown>;
            errorDetail =
              typeof nested.detail === "string" ? nested.detail : "";
          }
          if (!errorDetail && typeof errObj.detail === "string") {
            errorDetail = errObj.detail;
          }
        }
        if (!errorDetail && preStreamError instanceof Error) {
          errorDetail = preStreamError.message;
        }

        const preStreamAction = getPreStreamErrorAction(
          errorDetail,
          conversationBusyRetries,
          CONVERSATION_BUSY_MAX_RETRIES,
        );

        // Check for pending approval blocking new messages - resolve and retry.
        // This is distinct from "conversation busy" and needs approval resolution,
        // not just a timed delay.
        if (preStreamAction === "resolve_approval_pending") {
          if (outputFormat === "stream-json") {
            const recoveryMsg: RecoveryMessage = {
              type: "recovery",
              recovery_type: "approval_pending",
              message:
                "Detected pending approval conflict on send; resolving before retry",
              session_id: sessionId,
              uuid: `recovery-pre-stream-${crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(recoveryMsg));
          } else {
            console.error(
              "Pending approval detected, resolving before retry...",
            );
          }

          await resolveAllPendingApprovals();
          continue;
        }

        // Check for 409 "conversation busy" error - retry once with delay
        if (preStreamAction === "retry_conversation_busy") {
          conversationBusyRetries += 1;

          // Emit retry message for stream-json mode
          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: "error", // 409 conversation busy is a pre-stream error
              attempt: conversationBusyRetries,
              max_attempts: CONVERSATION_BUSY_MAX_RETRIES,
              delay_ms: CONVERSATION_BUSY_RETRY_DELAY_MS,
              session_id: sessionId,
              uuid: `retry-conversation-busy-${crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(retryMsg));
          } else {
            console.error(
              `Conversation is busy, waiting ${CONVERSATION_BUSY_RETRY_DELAY_MS / 1000}s and retrying...`,
            );
          }

          // Wait before retry
          await new Promise((resolve) =>
            setTimeout(resolve, CONVERSATION_BUSY_RETRY_DELAY_MS),
          );
          continue;
        }

        // Reset conversation busy retry counter on other errors
        conversationBusyRetries = 0;

        // Re-throw to outer catch for other errors
        throw preStreamError;
      }

      // For stream-json, output each chunk as it arrives
      let stopReason: StopReasonType | null = null;
      let approvals: Array<{
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      }> = [];
      let apiDurationMs: number;
      let lastRunId: string | null = null;
      let approvalPendingRecovery = false;

      if (outputFormat === "stream-json") {
        // Track approval requests across streamed chunks
        const autoApprovalEmitted = new Set<string>();

        const streamJsonHook: DrainStreamHook = async ({
          chunk,
          shouldOutput,
          errorInfo,
          updatedApproval,
        }) => {
          let shouldOutputChunk = shouldOutput;

          if (errorInfo && shouldOutput) {
            const errorEvent: ErrorMessage = {
              type: "error",
              message: errorInfo.message,
              stop_reason: "error",
              run_id: errorInfo.run_id,
              session_id: sessionId,
              uuid: crypto.randomUUID(),
              ...(errorInfo.error_type &&
                errorInfo.run_id && {
                  api_error: {
                    message_type: "error_message",
                    message: errorInfo.message,
                    error_type: errorInfo.error_type,
                    detail: errorInfo.detail,
                    run_id: errorInfo.run_id,
                  },
                }),
            };
            console.log(JSON.stringify(errorEvent));
            shouldOutputChunk = false;
          }

          // Detect server conflict due to pending approval; handle it and retry
          // Check both detail and message fields since error formats vary
          if (
            isApprovalPendingError(errorInfo?.detail) ||
            isApprovalPendingError(errorInfo?.message)
          ) {
            const recoveryRunId = errorInfo?.run_id;
            const recoveryMsg: RecoveryMessage = {
              type: "recovery",
              recovery_type: "approval_pending",
              message:
                "Detected pending approval conflict; auto-denying stale approval and retrying",
              run_id: recoveryRunId ?? undefined,
              session_id: sessionId,
              uuid: `recovery-${recoveryRunId || crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(recoveryMsg));
            approvalPendingRecovery = true;
            return { stopReason: "error", shouldAccumulate: true };
          }

          // Check if this approval will be auto-approved. Dedup per tool_call_id
          if (
            updatedApproval &&
            !autoApprovalEmitted.has(updatedApproval.toolCallId)
          ) {
            const { autoAllowed } = await classifyApprovals([updatedApproval], {
              alwaysRequiresUserInput: isInteractiveApprovalTool,
              requireArgsForAutoApprove: true,
              missingNameReason: "Tool call incomplete - missing name",
            });

            const [approval] = autoAllowed;
            if (approval) {
              const permission = approval.permission;
              shouldOutputChunk = false;
              const autoApprovalMsg: AutoApprovalMessage = {
                type: "auto_approval",
                tool_call: {
                  name: approval.approval.toolName,
                  tool_call_id: approval.approval.toolCallId,
                  arguments: approval.approval.toolArgs || "{}",
                },
                reason: permission.reason || "Allowed by permission rule",
                matched_rule:
                  "matchedRule" in permission && permission.matchedRule
                    ? permission.matchedRule
                    : "auto-approved",
                session_id: sessionId,
                uuid: `auto-approval-${approval.approval.toolCallId}`,
              };
              console.log(JSON.stringify(autoApprovalMsg));
              autoApprovalEmitted.add(approval.approval.toolCallId);
            }
          }

          if (shouldOutputChunk) {
            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const uuid = chunkWithIds.otid || chunkWithIds.id;

            if (includePartialMessages) {
              const streamEvent: StreamEvent = {
                type: "stream_event",
                event: chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(streamEvent));
            } else {
              const msg: MessageWire = {
                type: "message",
                ...chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(msg));
            }
          }

          return { shouldOutput: shouldOutputChunk, shouldAccumulate: true };
        };

        const result = await drainStreamWithResume(
          stream,
          buffers,
          () => {},
          undefined,
          undefined,
          streamJsonHook,
        );
        stopReason = result.stopReason;
        approvals = result.approvals || [];
        apiDurationMs = result.apiDurationMs;
        lastRunId = result.lastRunId || null;
        if (lastRunId) lastKnownRunId = lastRunId;
      } else {
        // Normal mode: use drainStreamWithResume
        const result = await drainStreamWithResume(
          stream,
          buffers,
          () => {}, // No UI refresh needed in headless mode
        );
        stopReason = result.stopReason;
        approvals = result.approvals || [];
        apiDurationMs = result.apiDurationMs;
        lastRunId = result.lastRunId || null;
        if (lastRunId) lastKnownRunId = lastRunId;
      }

      // Track API duration for this stream
      sessionStats.endTurn(apiDurationMs);

      // Check max turns after each turn (server may have taken multiple steps)
      checkMaxTurns();

      if (approvalPendingRecovery) {
        await resolveAllPendingApprovals();
        continue;
      }

      // Case 1: Turn ended normally
      if (stopReason === "end_turn") {
        // Reset retry counters on success
        llmApiErrorRetries = 0;
        conversationBusyRetries = 0;
        break;
      }

      // Case 2: Requires approval - batch process all approvals
      if (stopReason === "requires_approval") {
        if (approvals.length === 0) {
          console.error("Unexpected empty approvals array");
          process.exit(1);
        }

        // Phase 1: Collect decisions for all approvals
        type Decision =
          | {
              type: "approve";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
            }
          | {
              type: "deny";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
              reason: string;
            };

        const { autoAllowed, autoDenied, needsUserInput } =
          await classifyApprovals(approvals, {
            alwaysRequiresUserInput: isInteractiveApprovalTool,
            requireArgsForAutoApprove: true,
            missingNameReason: "Tool call incomplete - missing name",
          });

        const decisions: Decision[] = [
          ...autoAllowed.map((ac) => ({
            type: "approve" as const,
            approval: ac.approval,
          })),
          ...needsUserInput.map((ac) => {
            // One-shot headless mode has no control channel for interactive
            // approvals. Match Claude behavior by auto-allowing EnterPlanMode
            // while denying tools that need runtime user responses.
            if (isHeadlessAutoAllowTool(ac.approval.toolName)) {
              return {
                type: "approve" as const,
                approval: ac.approval,
              };
            }
            return {
              type: "deny" as const,
              approval: ac.approval,
              reason: "Tool requires approval (headless mode)",
            };
          }),
          ...autoDenied.map((ac) => {
            const fallback =
              "matchedRule" in ac.permission && ac.permission.matchedRule
                ? `Permission denied: ${ac.permission.matchedRule}`
                : ac.permission.reason
                  ? `Permission denied: ${ac.permission.reason}`
                  : "Permission denied: Unknown reason";
            return {
              type: "deny" as const,
              approval: ac.approval,
              reason: ac.denyReason ?? fallback,
            };
          }),
        ];

        // Phase 2: Execute all approved tools and format results using shared function
        const { executeApprovalBatch } = await import(
          "./agent/approval-execution"
        );
        const executedResults = await executeApprovalBatch(decisions);

        // Send all results in one batch
        currentInput = [
          {
            type: "approval",
            approvals: executedResults as ApprovalResult[],
          },
        ];
        continue;
      }

      // Cache latest error text for this turn
      let latestErrorText: string | null = null;
      const linesForTurn = toLines(buffers);
      for (let i = linesForTurn.length - 1; i >= 0; i -= 1) {
        const line = linesForTurn[i];
        if (
          line?.kind === "error" &&
          "text" in line &&
          typeof line.text === "string"
        ) {
          latestErrorText = line.text;
          break;
        }
      }

      // Fetch run error detail for invalid tool call ID detection
      const detailFromRun = await fetchRunErrorDetail(lastRunId);

      // Case 3: Transient LLM API error - retry with exponential backoff up to a limit
      if (stopReason === "llm_api_error") {
        if (llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          const attempt = llmApiErrorRetries + 1;
          const baseDelayMs = 1000;
          const delayMs = baseDelayMs * 2 ** (attempt - 1);

          llmApiErrorRetries = attempt;

          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: "llm_api_error",
              attempt,
              max_attempts: LLM_API_ERROR_MAX_RETRIES,
              delay_ms: delayMs,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `retry-${lastRunId || crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(retryMsg));
          } else {
            const delaySeconds = Math.round(delayMs / 1000);
            console.error(
              `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
            );
          }

          // Exponential backoff before retrying the same input
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          continue;
        }
      }

      // "Invalid tool call IDs" means server HAS pending approvals but with different IDs.
      // Fetch the actual pending approvals and process them before retrying.
      const invalidIdsDetected =
        isInvalidToolCallIdsError(detailFromRun) ||
        isInvalidToolCallIdsError(latestErrorText);

      if (invalidIdsDetected) {
        if (outputFormat === "stream-json") {
          const recoveryMsg: RecoveryMessage = {
            type: "recovery",
            recovery_type: "invalid_tool_call_ids",
            message:
              "Tool call ID mismatch; fetching actual pending approvals and resyncing",
            run_id: lastRunId ?? undefined,
            session_id: sessionId,
            uuid: `recovery-${lastRunId || crypto.randomUUID()}`,
          };
          console.log(JSON.stringify(recoveryMsg));
        } else {
          console.error(
            "Tool call ID mismatch; fetching actual pending approvals...",
          );
        }

        try {
          // Fetch and process actual pending approvals from server
          await resolveAllPendingApprovals();
          // After processing, continue to next iteration (fresh state)
          continue;
        } catch {
          // If fetch fails, exit with error
          if (outputFormat === "stream-json") {
            const errorMsg: ErrorMessage = {
              type: "error",
              message: "Failed to fetch pending approvals for resync",
              stop_reason: stopReason,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `error-${lastRunId || crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(errorMsg));
          } else {
            console.error("Failed to fetch pending approvals for resync");
          }
          process.exit(1);
        }
      }

      // Unexpected stop reason (error, llm_api_error, etc.)
      // Before failing, check run metadata to see if this is a retriable error
      // This handles cases where the backend sends a generic error stop_reason but the
      // underlying cause is a transient LLM/network issue that should be retried

      // Early exit for stop reasons that should never be retried
      const nonRetriableReasons: StopReasonType[] = [
        "cancelled",
        "requires_approval",
        "max_steps",
        "max_tokens_exceeded",
        "context_window_overflow_in_system_prompt",
        "end_turn",
        "tool_rule",
        "no_tool_call",
      ];
      if (nonRetriableReasons.includes(stopReason)) {
        // Fall through to error display
      } else if (lastRunId && llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
        try {
          const run = await client.runs.retrieve(lastRunId);
          const metaError = run.metadata?.error as
            | {
                error_type?: string;
                message?: string;
                detail?: string;
                // Handle nested error structure (error.error) that can occur in some edge cases
                error?: { error_type?: string; detail?: string };
              }
            | undefined;

          // Check for llm_error at top level or nested (handles error.error nesting)
          const errorType =
            metaError?.error_type ?? metaError?.error?.error_type;

          // Fallback: detect LLM provider errors from detail even if misclassified
          // Patterns are derived from handle_llm_error() message formats in the backend
          const detail = metaError?.detail ?? metaError?.error?.detail ?? "";

          // Don't retry 4xx client errors (validation, auth, malformed requests)
          // These are not transient and won't succeed on retry
          const is4xxError = /Error code: 4\d{2}/.test(detail);

          const llmProviderPatterns = [
            "Anthropic API error", // anthropic_client.py:759
            "OpenAI API error", // openai_client.py:1034
            "Google Vertex API error", // google_vertex_client.py:848
            "overloaded", // anthropic_client.py:753 - used for LLMProviderOverloaded
            "api_error", // Anthropic SDK error type field
            "Network error", // Transient network failures during streaming
            "Connection error during Anthropic streaming", // Peer disconnections, incomplete chunked reads
          ];
          const isLlmErrorFromDetail = llmProviderPatterns.some((pattern) =>
            detail.includes(pattern),
          );

          if (
            (errorType === "llm_error" || isLlmErrorFromDetail) &&
            !is4xxError
          ) {
            const attempt = llmApiErrorRetries + 1;
            const baseDelayMs = 1000;
            const delayMs = baseDelayMs * 2 ** (attempt - 1);

            llmApiErrorRetries = attempt;

            if (outputFormat === "stream-json") {
              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "llm_api_error",
                attempt,
                max_attempts: LLM_API_ERROR_MAX_RETRIES,
                delay_ms: delayMs,
                run_id: lastRunId ?? undefined,
                session_id: sessionId,
                uuid: `retry-${lastRunId || crypto.randomUUID()}`,
              };
              console.log(JSON.stringify(retryMsg));
            } else {
              const delaySeconds = Math.round(delayMs / 1000);
              console.error(
                `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
              );
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
        } catch (_e) {
          // If we can't fetch run metadata, fall through to normal error handling
        }
      }

      // Mark incomplete tool calls as cancelled to prevent stuck state
      markIncompleteToolsAsCancelled(buffers, true, "stream_error");

      // Extract error details from buffers if available
      const errorLines = toLines(buffers).filter(
        (line) => line.kind === "error",
      );
      const errorMessages = errorLines
        .map((line) => ("text" in line ? line.text : ""))
        .filter(Boolean);

      let errorMessage =
        errorMessages.length > 0
          ? errorMessages.join("; ")
          : `Unexpected stop reason: ${stopReason}`;

      // Fetch detailed error from run metadata if available (same as TUI mode)
      if (lastRunId && errorMessages.length === 0) {
        try {
          const run = await client.runs.retrieve(lastRunId);
          if (run.metadata?.error) {
            const errorData = run.metadata.error as {
              type?: string;
              message?: string;
              detail?: string;
            };
            // Construct error object that formatErrorDetails can parse
            const errorObject = {
              error: {
                error: errorData,
                run_id: lastRunId,
              },
            };
            errorMessage = formatErrorDetails(errorObject, agent.id);
          }
        } catch (_e) {
          // If we can't fetch error details, append note to error message
          errorMessage = `${errorMessage}\n(Unable to fetch additional error details from server)`;
        }
      }

      if (outputFormat === "stream-json") {
        // Emit error event
        const errorMsg: ErrorMessage = {
          type: "error",
          message: errorMessage,
          stop_reason: stopReason,
          run_id: lastRunId ?? undefined,
          session_id: sessionId,
          uuid: `error-${lastRunId || crypto.randomUUID()}`,
        };
        console.log(JSON.stringify(errorMsg));
      } else {
        console.error(`Error: ${errorMessage}`);
      }
      process.exit(1);
    }
  } catch (error) {
    // Mark incomplete tool calls as cancelled
    markIncompleteToolsAsCancelled(buffers, true, "stream_error");

    // Use comprehensive error formatting (same as TUI mode)
    const errorDetails = formatErrorDetails(error, agent.id);

    if (outputFormat === "stream-json") {
      const errorMsg: ErrorMessage = {
        type: "error",
        message: errorDetails,
        stop_reason: "error",
        run_id: lastKnownRunId ?? undefined,
        session_id: sessionId,
        uuid: `error-${lastKnownRunId || crypto.randomUUID()}`,
      };
      console.log(JSON.stringify(errorMsg));
    } else {
      console.error(`Error: ${errorDetails}`);
    }
    process.exit(1);
  }

  // Update stats with final usage data from buffers
  sessionStats.updateUsageFromBuffers(buffers);

  // Extract final result from transcript, with sensible fallbacks
  const lines = toLines(buffers);
  const reversed = [...lines].reverse();

  const lastAssistant = reversed.find(
    (line) =>
      line.kind === "assistant" &&
      "text" in line &&
      typeof line.text === "string" &&
      line.text.trim().length > 0,
  ) as Extract<Line, { kind: "assistant" }> | undefined;

  const lastReasoning = reversed.find(
    (line) =>
      line.kind === "reasoning" &&
      "text" in line &&
      typeof line.text === "string" &&
      line.text.trim().length > 0,
  ) as Extract<Line, { kind: "reasoning" }> | undefined;

  const lastToolResult = reversed.find(
    (line) =>
      line.kind === "tool_call" &&
      "resultText" in line &&
      typeof (line as Extract<Line, { kind: "tool_call" }>).resultText ===
        "string" &&
      ((line as Extract<Line, { kind: "tool_call" }>).resultText ?? "").trim()
        .length > 0,
  ) as Extract<Line, { kind: "tool_call" }> | undefined;

  const resultText =
    lastAssistant?.text ||
    lastReasoning?.text ||
    lastToolResult?.resultText ||
    "No assistant response found";

  // Output based on format
  if (outputFormat === "json") {
    const stats = sessionStats.getSnapshot();
    const output = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: agent.id,
      conversation_id: conversationId,
      usage: {
        prompt_tokens: stats.usage.promptTokens,
        completion_tokens: stats.usage.completionTokens,
        total_tokens: stats.usage.totalTokens,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (outputFormat === "stream-json") {
    // Output final result event
    const stats = sessionStats.getSnapshot();

    // Collect all run_ids from buffers
    const allRunIds = new Set<string>();
    for (const line of toLines(buffers)) {
      // Extract run_id from any line that might have it
      // This is a fallback in case we missed any during streaming
      if ("run_id" in line && typeof line.run_id === "string") {
        allRunIds.add(line.run_id);
      }
    }

    // Use the last run_id as the result uuid if available, otherwise derive from agent_id
    const resultUuid =
      allRunIds.size > 0
        ? `result-${Array.from(allRunIds).pop()}`
        : `result-${agent.id}`;
    const resultEvent: ResultMessage = {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: agent.id,
      conversation_id: conversationId,
      run_ids: Array.from(allRunIds),
      usage: {
        prompt_tokens: stats.usage.promptTokens,
        completion_tokens: stats.usage.completionTokens,
        total_tokens: stats.usage.totalTokens,
      },
      uuid: resultUuid,
    };
    console.log(JSON.stringify(resultEvent));
  } else {
    // text format (default)
    if (!resultText || resultText === "No assistant response found") {
      console.error("No assistant response found");
      process.exit(1);
    }
    console.log(resultText);
  }

  // Report all milestones at the end for latency audit
  markMilestone("HEADLESS_COMPLETE");
  reportAllMilestones();
}

/**
 * Bidirectional mode for SDK communication.
 * Reads JSON messages from stdin, processes them, and outputs responses.
 * Stays alive until stdin closes.
 */
async function runBidirectionalMode(
  agent: AgentState,
  conversationId: string,
  client: Letta,
  _outputFormat: string,
  includePartialMessages: boolean,
  availableTools: string[],
): Promise<void> {
  const sessionId = agent.id;
  const readline = await import("node:readline");

  // Emit init event
  const initEvent = {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    agent_id: agent.id,
    conversation_id: conversationId,
    model: agent.llm_config?.model,
    tools: availableTools,
    cwd: process.cwd(),
    uuid: `init-${agent.id}`,
  };
  console.log(JSON.stringify(initEvent));

  // Track current operation for interrupt support
  let currentAbortController: AbortController | null = null;

  // Resolve pending approvals for this conversation before retrying user input.
  const resolveAllPendingApprovals = async () => {
    const { getResumeData } = await import("./agent/check-approval");
    while (true) {
      // Re-fetch agent to get latest in-context messages (source of truth for backend)
      const freshAgent = await client.agents.retrieve(agent.id);

      let resume: Awaited<ReturnType<typeof getResumeData>>;
      try {
        resume = await getResumeData(client, freshAgent, conversationId);
      } catch (error) {
        // Treat 404/422 as "no approvals" - stale message/conversation state
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 422)
        ) {
          break;
        }
        throw error;
      }

      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) break;

      type Decision =
        | {
            type: "approve";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
            matchedRule: string;
          }
        | {
            type: "deny";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
          };

      const { autoAllowed, autoDenied } = await classifyApprovals(
        pendingApprovals,
        {
          treatAskAsDeny: true,
          denyReasonForAsk: "Tool requires approval (headless mode)",
          requireArgsForAutoApprove: true,
          missingNameReason: "Tool call incomplete - missing name",
        },
      );

      const decisions: Decision[] = [
        ...autoAllowed.map((ac) => ({
          type: "approve" as const,
          approval: ac.approval,
          reason: ac.permission.reason || "Allowed by permission rule",
          matchedRule:
            "matchedRule" in ac.permission && ac.permission.matchedRule
              ? ac.permission.matchedRule
              : "auto-approved",
        })),
        ...autoDenied.map((ac) => {
          const fallback =
            "matchedRule" in ac.permission && ac.permission.matchedRule
              ? `Permission denied: ${ac.permission.matchedRule}`
              : ac.permission.reason
                ? `Permission denied: ${ac.permission.reason}`
                : "Permission denied: Unknown reason";
          return {
            type: "deny" as const,
            approval: ac.approval,
            reason: ac.denyReason ?? fallback,
          };
        }),
      ];

      const { executeApprovalBatch } = await import(
        "./agent/approval-execution"
      );
      const executedResults = await executeApprovalBatch(decisions);

      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: executedResults as ApprovalResult[],
      };

      const approvalMessages: Array<
        | import("@letta-ai/letta-client/resources/agents/agents").MessageCreate
        | import("@letta-ai/letta-client/resources/agents/messages").ApprovalCreate
      > = [approvalInput];

      {
        const { consumeQueuedSkillContent } = await import(
          "./tools/impl/skillContentRegistry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          approvalMessages.push({
            role: "user" as const,
            content: skillContents.map((sc) => ({
              type: "text" as const,
              text: sc.content,
            })),
          });
        }
      }

      const approvalStream = await sendMessageStream(
        conversationId,
        approvalMessages,
        { agentId: agent.id },
      );
      await drainStreamWithResume(
        approvalStream,
        createBuffers(agent.id),
        () => {},
      );
    }
  };

  // Create readline interface for stdin
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  // Create async iterator and line queue for permission callbacks
  const lineQueue: string[] = [];
  let lineResolver: ((line: string | null) => void) | null = null;

  // Feed lines into queue or resolver
  rl.on("line", (line) => {
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on("close", () => {
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(null);
    }
  });

  // Helper to get next line (from queue or wait)
  async function getNextLine(): Promise<string | null> {
    if (lineQueue.length > 0) {
      return lineQueue.shift() ?? null;
    }
    return new Promise<string | null>((resolve) => {
      lineResolver = resolve;
    });
  }

  // Helper to send permission request and wait for response
  // Uses Claude SDK's control_request/control_response format for compatibility
  async function requestPermission(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{
    decision: "allow" | "deny";
    reason?: string;
    updatedInput?: Record<string, unknown> | null;
  }> {
    const requestId = `perm-${toolCallId}`;

    // Build can_use_tool control request (Claude SDK format)
    const canUseToolRequest: CanUseToolControlRequest = {
      subtype: "can_use_tool",
      tool_name: toolName,
      input: toolInput,
      tool_call_id: toolCallId, // Letta-specific
      permission_suggestions: [], // TODO: not implemented
      blocked_path: null, // TODO: not implemented
    };

    const controlRequest: ControlRequest = {
      type: "control_request",
      request_id: requestId,
      request: canUseToolRequest,
    };

    console.log(JSON.stringify(controlRequest));

    const deferredLines: string[] = [];

    // Wait for control_response
    let result: {
      decision: "allow" | "deny";
      reason?: string;
      updatedInput?: Record<string, unknown> | null;
    } | null = null;

    while (result === null) {
      const line = await getNextLine();
      if (line === null) {
        result = { decision: "deny", reason: "stdin closed" };
        break;
      }
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);
        if (
          msg.type === "control_response" &&
          msg.response?.request_id === requestId
        ) {
          // Parse the can_use_tool response
          const response = msg.response?.response as
            | CanUseToolResponse
            | undefined;
          if (!response) {
            result = { decision: "deny", reason: "Invalid response format" };
            break;
          }

          if (response.behavior === "allow") {
            result = {
              decision: "allow",
              updatedInput: response.updatedInput,
            };
          } else {
            result = {
              decision: "deny",
              reason: response.message,
              // TODO: handle interrupt flag
            };
          }
          break;
        }

        // Defer other messages for the main loop without re-reading them.
        deferredLines.push(line);
      } catch {
        // Defer parse errors so the main loop can surface them.
        deferredLines.push(line);
      }
    }

    if (deferredLines.length > 0) {
      lineQueue.unshift(...deferredLines);
    }

    return result;
  }

  // Main processing loop
  while (true) {
    const line = await getNextLine();
    if (line === null) break; // stdin closed
    if (!line.trim()) continue;

    let message: {
      type: string;
      message?: { role: string; content: string };
      request_id?: string;
      request?: { subtype: string };
      session_id?: string;
    };

    try {
      message = JSON.parse(line);
    } catch {
      const errorMsg: ErrorMessage = {
        type: "error",
        message: "Invalid JSON input",
        stop_reason: "error",
        session_id: sessionId,
        uuid: crypto.randomUUID(),
      };
      console.log(JSON.stringify(errorMsg));
      continue;
    }

    // Handle control requests
    if (message.type === "control_request") {
      const subtype = message.request?.subtype;
      const requestId = message.request_id;

      if (subtype === "initialize") {
        // Return session info
        const initResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
            response: {
              agent_id: agent.id,
              model: agent.llm_config?.model,
              tools: availableTools,
            },
          },
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(initResponse));
      } else if (subtype === "interrupt") {
        // Abort current operation if any
        if (currentAbortController !== null) {
          (currentAbortController as AbortController).abort();
          currentAbortController = null;
        }
        const interruptResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
          },
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(interruptResponse));
      } else if (subtype === "register_external_tools") {
        // Register external tools from SDK
        const toolsRequest = message.request as {
          tools?: ExternalToolDefinition[];
        };
        const tools = toolsRequest.tools ?? [];

        registerExternalTools(tools);

        // Set up the external tool executor to send requests back to SDK
        setExternalToolExecutor(async (toolCallId, toolName, input) => {
          // Send execute_external_tool request to SDK
          const execRequest: ControlRequest = {
            type: "control_request",
            request_id: `ext-${toolCallId}`,
            request: {
              subtype: "execute_external_tool",
              tool_call_id: toolCallId,
              tool_name: toolName,
              input,
            } as unknown as CanUseToolControlRequest, // Type cast for compatibility
          };
          console.log(JSON.stringify(execRequest));

          // Wait for external_tool_result response
          while (true) {
            const line = await getNextLine();
            if (line === null) {
              return {
                content: [{ type: "text", text: "stdin closed" }],
                isError: true,
              };
            }
            if (!line.trim()) continue;

            try {
              const msg = JSON.parse(line);
              if (
                msg.type === "control_response" &&
                msg.response?.subtype === "external_tool_result" &&
                msg.response?.tool_call_id === toolCallId
              ) {
                return {
                  content: msg.response.content ?? [{ type: "text", text: "" }],
                  isError: msg.response.is_error ?? false,
                };
              }
            } catch {
              // Ignore parse errors, keep waiting
            }
          }
        });

        const registerResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
            response: { registered: tools.length },
          },
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(registerResponse));
      } else {
        const errorResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId ?? "",
            error: `Unknown control request subtype: ${subtype}`,
          },
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(errorResponse));
      }
      continue;
    }

    // Handle user messages
    if (message.type === "user" && message.message?.content) {
      const userContent = message.message.content;

      // Create abort controller for this operation
      currentAbortController = new AbortController();

      try {
        const buffers = createBuffers(agent.id);
        const startTime = performance.now();
        let numTurns = 0;
        let lastStopReason: StopReasonType | null = null; // Track for result subtype
        let sawStreamError = false; // Track if we emitted an error during streaming

        // Inject available skills as system-reminder for bidirectional mode (LET-7353)
        let enrichedContent = userContent;
        if (typeof enrichedContent === "string") {
          try {
            const {
              discoverSkills: discover,
              SKILLS_DIR: defaultDir,
              formatSkillsAsSystemReminder,
            } = await import("./agent/skills");
            const { getSkillsDirectory } = await import("./agent/context");
            const { join } = await import("node:path");
            const skillsDir =
              getSkillsDirectory() || join(process.cwd(), defaultDir);
            const { skills } = await discover(skillsDir, agent.id);
            const skillsReminder = formatSkillsAsSystemReminder(skills);
            if (skillsReminder) {
              enrichedContent = `${skillsReminder}\n\n${enrichedContent}`;
            }
          } catch {
            // Skills discovery failed, skip
          }
        }

        // Initial input is the user message
        let currentInput: MessageCreate[] = [
          { role: "user", content: enrichedContent },
        ];

        // Approval handling loop - continue until end_turn or error
        while (true) {
          numTurns++;

          // Check if aborted
          if (currentAbortController?.signal.aborted) {
            break;
          }

          // Inject queued skill content as user message parts (LET-7353)
          {
            const { consumeQueuedSkillContent } = await import(
              "./tools/impl/skillContentRegistry"
            );
            const skillContents = consumeQueuedSkillContent();
            if (skillContents.length > 0) {
              currentInput = [
                ...currentInput,
                {
                  role: "user" as const,
                  content: skillContents.map((sc) => ({
                    type: "text" as const,
                    text: sc.content,
                  })),
                },
              ];
            }
          }

          // Send message to agent.
          // Wrap in try-catch to handle pre-stream 409 approval-pending errors.
          let stream: Awaited<ReturnType<typeof sendMessageStream>>;
          try {
            stream = await sendMessageStream(conversationId, currentInput, {
              agentId: agent.id,
            });
          } catch (preStreamError) {
            let errorDetail = "";
            if (
              preStreamError instanceof APIError &&
              preStreamError.error &&
              typeof preStreamError.error === "object"
            ) {
              const errObj = preStreamError.error as Record<string, unknown>;
              if (
                errObj.error &&
                typeof errObj.error === "object" &&
                "detail" in errObj.error
              ) {
                const nested = errObj.error as Record<string, unknown>;
                errorDetail =
                  typeof nested.detail === "string" ? nested.detail : "";
              }
              if (!errorDetail && typeof errObj.detail === "string") {
                errorDetail = errObj.detail;
              }
            }
            if (!errorDetail && preStreamError instanceof Error) {
              errorDetail = preStreamError.message;
            }

            if (isApprovalPendingError(errorDetail)) {
              const recoveryMsg: RecoveryMessage = {
                type: "recovery",
                recovery_type: "approval_pending",
                message:
                  "Detected pending approval conflict on send; resolving before retry",
                session_id: sessionId,
                uuid: `recovery-bidir-${crypto.randomUUID()}`,
              };
              console.log(JSON.stringify(recoveryMsg));
              await resolveAllPendingApprovals();
              continue;
            }

            throw preStreamError;
          }
          const streamJsonHook: DrainStreamHook = ({
            chunk,
            shouldOutput,
            errorInfo,
          }) => {
            // Handle in-stream errors (emit ErrorMessage with full details)
            if (errorInfo && shouldOutput) {
              sawStreamError = true; // Track that we saw an error (affects result subtype)
              const errorEvent: ErrorMessage = {
                type: "error",
                message: errorInfo.message,
                stop_reason: "error",
                run_id: errorInfo.run_id,
                session_id: sessionId,
                uuid: crypto.randomUUID(),
                ...(errorInfo.error_type &&
                  errorInfo.run_id && {
                    api_error: {
                      message_type: "error_message",
                      message: errorInfo.message,
                      error_type: errorInfo.error_type,
                      detail: errorInfo.detail,
                      run_id: errorInfo.run_id,
                    },
                  }),
              };
              console.log(JSON.stringify(errorEvent));
              return { shouldAccumulate: true };
            }

            if (!shouldOutput) {
              return { shouldAccumulate: true };
            }

            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const uuid = chunkWithIds.otid || chunkWithIds.id;

            if (includePartialMessages) {
              const streamEvent: StreamEvent = {
                type: "stream_event",
                event: chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(streamEvent));
            } else {
              const msg: MessageWire = {
                type: "message",
                ...chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(msg));
            }

            return { shouldAccumulate: true };
          };

          const result = await drainStreamWithResume(
            stream,
            buffers,
            () => {},
            currentAbortController?.signal,
            undefined,
            streamJsonHook,
          );
          const stopReason = result.stopReason;
          lastStopReason = stopReason; // Track for result subtype
          const approvals = result.approvals || [];

          // Case 1: Turn ended normally - break out of loop
          if (stopReason === "end_turn") {
            break;
          }

          // Case 2: Aborted - break out of loop
          if (
            currentAbortController?.signal.aborted ||
            stopReason === "cancelled"
          ) {
            break;
          }

          // Case 3: Requires approval - process approvals and continue
          if (stopReason === "requires_approval") {
            if (approvals.length === 0) {
              // Anomalous state: requires_approval but no approvals
              // Treat as error rather than false-positive success
              lastStopReason = "error";
              break;
            }

            // Check permissions and collect decisions
            type Decision =
              | {
                  type: "approve";
                  approval: {
                    toolCallId: string;
                    toolName: string;
                    toolArgs: string;
                  };
                  matchedRule: string;
                }
              | {
                  type: "deny";
                  approval: {
                    toolCallId: string;
                    toolName: string;
                    toolArgs: string;
                  };
                  reason: string;
                };

            const { autoAllowed, autoDenied, needsUserInput } =
              await classifyApprovals(approvals, {
                alwaysRequiresUserInput: isInteractiveApprovalTool,
                requireArgsForAutoApprove: true,
                missingNameReason: "Tool call incomplete - missing name",
              });

            const decisions: Decision[] = [
              ...autoAllowed.map((ac) => ({
                type: "approve" as const,
                approval: ac.approval,
                matchedRule:
                  "matchedRule" in ac.permission && ac.permission.matchedRule
                    ? ac.permission.matchedRule
                    : "auto-approved",
              })),
              ...autoDenied.map((ac) => {
                const fallback =
                  "matchedRule" in ac.permission && ac.permission.matchedRule
                    ? `Permission denied: ${ac.permission.matchedRule}`
                    : ac.permission.reason
                      ? `Permission denied: ${ac.permission.reason}`
                      : "Permission denied: Unknown reason";
                return {
                  type: "deny" as const,
                  approval: ac.approval,
                  reason: ac.denyReason ?? fallback,
                };
              }),
            ];

            for (const approvalItem of autoAllowed) {
              const permission = approvalItem.permission;
              const autoApprovalMsg: AutoApprovalMessage = {
                type: "auto_approval",
                tool_call: {
                  name: approvalItem.approval.toolName,
                  tool_call_id: approvalItem.approval.toolCallId,
                  arguments: approvalItem.approval.toolArgs,
                },
                reason: permission.reason || "auto-approved",
                matched_rule:
                  "matchedRule" in permission && permission.matchedRule
                    ? permission.matchedRule
                    : "auto-approved",
                session_id: sessionId,
                uuid: `auto-approval-${approvalItem.approval.toolCallId}`,
              };
              console.log(JSON.stringify(autoApprovalMsg));
            }

            for (const ac of needsUserInput) {
              // permission.decision === "ask" - request permission from SDK
              const permResponse = await requestPermission(
                ac.approval.toolCallId,
                ac.approval.toolName,
                ac.parsedArgs,
              );

              if (permResponse.decision === "allow") {
                // If provided updatedInput (e.g., for AskUserQuestion with answers),
                // update the approval's toolArgs to use it
                const finalApproval = permResponse.updatedInput
                  ? {
                      ...ac.approval,
                      toolArgs: JSON.stringify(permResponse.updatedInput),
                    }
                  : ac.approval;

                decisions.push({
                  type: "approve",
                  approval: finalApproval,
                  matchedRule: "SDK callback approved",
                });

                // Emit auto_approval event for SDK-approved tool
                const autoApprovalMsg: AutoApprovalMessage = {
                  type: "auto_approval",
                  tool_call: {
                    name: finalApproval.toolName,
                    tool_call_id: finalApproval.toolCallId,
                    arguments: finalApproval.toolArgs,
                  },
                  reason: permResponse.reason || "SDK callback approved",
                  matched_rule: "canUseTool callback",
                  session_id: sessionId,
                  uuid: `auto-approval-${ac.approval.toolCallId}`,
                };
                console.log(JSON.stringify(autoApprovalMsg));
              } else {
                decisions.push({
                  type: "deny",
                  approval: ac.approval,
                  reason: permResponse.reason || "Denied by SDK callback",
                });
              }
            }

            // Execute approved tools
            const { executeApprovalBatch } = await import(
              "./agent/approval-execution"
            );
            const executedResults = await executeApprovalBatch(decisions);

            // Send approval results back to continue
            currentInput = [
              {
                type: "approval",
                approvals: executedResults,
              } as unknown as MessageCreate,
            ];

            // Continue the loop to process the next stream
            continue;
          }

          // Other stop reasons - break
          break;
        }

        // Emit result
        const durationMs = performance.now() - startTime;
        const lines = toLines(buffers);
        const reversed = [...lines].reverse();
        const lastAssistant = reversed.find(
          (line) =>
            line.kind === "assistant" &&
            "text" in line &&
            typeof line.text === "string" &&
            line.text.trim().length > 0,
        ) as Extract<Line, { kind: "assistant" }> | undefined;
        const lastReasoning = reversed.find(
          (line) =>
            line.kind === "reasoning" &&
            "text" in line &&
            typeof line.text === "string" &&
            line.text.trim().length > 0,
        ) as Extract<Line, { kind: "reasoning" }> | undefined;
        const lastToolResult = reversed.find(
          (line) =>
            line.kind === "tool_call" &&
            "resultText" in line &&
            typeof (line as Extract<Line, { kind: "tool_call" }>).resultText ===
              "string" &&
            (
              (line as Extract<Line, { kind: "tool_call" }>).resultText ?? ""
            ).trim().length > 0,
        ) as Extract<Line, { kind: "tool_call" }> | undefined;
        const resultText =
          lastAssistant?.text ||
          lastReasoning?.text ||
          lastToolResult?.resultText ||
          "";

        // Determine result subtype based on how the turn ended
        const isAborted = currentAbortController?.signal.aborted;
        // isError if: (1) stop reason indicates error, OR (2) we emitted an error during streaming
        const isError =
          sawStreamError ||
          (lastStopReason &&
            lastStopReason !== "end_turn" &&
            lastStopReason !== "requires_approval");
        const subtype: ResultMessage["subtype"] = isAborted
          ? "interrupted"
          : isError
            ? "error"
            : "success";

        const resultMsg: ResultMessage = {
          type: "result",
          subtype,
          session_id: sessionId,
          duration_ms: Math.round(durationMs),
          duration_api_ms: 0, // Not tracked in bidirectional mode
          num_turns: numTurns,
          result: resultText,
          agent_id: agent.id,
          conversation_id: conversationId,
          run_ids: [],
          usage: null,
          uuid: `result-${agent.id}-${Date.now()}`,
          // Include stop_reason only when subtype is "error" (not "interrupted")
          ...(subtype === "error" && {
            stop_reason:
              lastStopReason && lastStopReason !== "end_turn"
                ? lastStopReason
                : "error", // Use "error" if sawStreamError but lastStopReason was end_turn
          }),
        };
        console.log(JSON.stringify(resultMsg));
      } catch (error) {
        // Use formatErrorDetails for comprehensive error formatting (same as one-shot mode)
        const errorDetails = formatErrorDetails(error, agent.id);
        const errorMsg: ErrorMessage = {
          type: "error",
          message: errorDetails,
          stop_reason: "error",
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(errorMsg));

        // Also emit a result message with subtype: "error" so SDK knows the turn failed
        const errorResultMsg: ResultMessage = {
          type: "result",
          subtype: "error",
          session_id: sessionId,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          result: null,
          agent_id: agent.id,
          conversation_id: conversationId,
          run_ids: [],
          usage: null,
          uuid: `result-error-${agent.id}-${Date.now()}`,
          stop_reason: "error",
        };
        console.log(JSON.stringify(errorResultMsg));
      } finally {
        currentAbortController = null;
      }
      continue;
    }

    // Unknown message type
    const errorMsg: ErrorMessage = {
      type: "error",
      message: `Unknown message type: ${message.type}`,
      stop_reason: "error",
      session_id: sessionId,
      uuid: crypto.randomUUID(),
    };
    console.log(JSON.stringify(errorMsg));
  }

  // Stdin closed, exit gracefully
  process.exit(0);
}
