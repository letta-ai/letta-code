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
  buildApprovalRecoveryMessage,
  fetchRunErrorDetail,
  isApprovalPendingError,
  isApprovalStateDesyncError,
} from "./agent/approval-recovery";
import { getClient } from "./agent/client";
import { initializeLoadedSkillsFlag, setAgentContext } from "./agent/context";
import { createAgent } from "./agent/create";
import { ensureSkillsBlocks, ISOLATED_BLOCK_LABELS } from "./agent/memory";
import { sendMessageStream } from "./agent/message";
import { getModelUpdateArgs } from "./agent/model";
import { SessionStats } from "./agent/stats";
import {
  createBuffers,
  type Line,
  markIncompleteToolsAsCancelled,
  toLines,
} from "./cli/helpers/accumulator";
import { formatErrorDetails } from "./cli/helpers/errorFormatter";
import { safeJsonParseOr } from "./cli/helpers/safeJsonParse";
import { drainStreamWithResume } from "./cli/helpers/stream";
import { StreamProcessor } from "./cli/helpers/streamProcessor";
import { settingsManager } from "./settings-manager";
import { checkToolPermission } from "./tools/manager";
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
      "new-agent": { type: "boolean" },
      new: { type: "boolean" }, // Deprecated - kept for helpful error message
      agent: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
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

  // Check for deprecated --new flag
  if (values.new) {
    console.error(
      "Error: --new has been renamed to --new-agent\n" +
        'Usage: letta -p "..." --new-agent',
    );
    process.exit(1);
  }

  // Resolve agent (same logic as interactive mode)
  let agent: AgentState | null = null;
  const specifiedAgentId = values.agent as string | undefined;
  const specifiedConversationId = values.conversation as string | undefined;
  const shouldContinue = values.continue as boolean | undefined;
  const forceNew = values["new-agent"] as boolean | undefined;
  const systemPromptPreset = values.system as string | undefined;
  const systemCustom = values["system-custom"] as string | undefined;
  const systemAppend = values["system-append"] as string | undefined;
  const memoryBlocksJson = values["memory-blocks"] as string | undefined;
  const blockValueArgs = values["block-value"] as string[] | undefined;
  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  const sleeptimeFlag = (values.sleeptime as boolean | undefined) ?? undefined;
  const fromAfFile = values["from-af"] as string | undefined;

  // Validate --conversation flag (mutually exclusive with agent-selection flags)
  if (specifiedConversationId) {
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

  // Validate --from-af flag
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

  // Priority 1: Import from AgentFile template
  if (!agent && fromAfFile) {
    const { importAgentFromFile } = await import("./agent/import");
    const result = await importAgentFromFile({
      filePath: fromAfFile,
      modelOverride: model,
      stripMessages: true,
    });
    agent = result.agent;
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

      // Optimization: Skip update if agent is already using the specified model
      const currentModel = agent.llm_config?.model;
      const currentEndpointType = agent.llm_config?.model_endpoint_type;
      const currentHandle = `${currentEndpointType}/${currentModel}`;

      if (currentHandle !== modelHandle) {
        const { updateAgentLLMConfig } = await import("./agent/modify");
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
        console.error(`Failed to update system prompt: ${result.message}`);
        process.exit(1);
      }
      agent = result.agent;
    }
  }

  // Determine which conversation to use
  let conversationId: string;

  // Only isolate blocks that actually exist on this agent
  // If initBlocks is undefined, agent has default blocks (all ISOLATED_BLOCK_LABELS exist)
  // If initBlocks is defined, only isolate blocks that are in both lists
  const isolatedBlockLabels: string[] =
    initBlocks === undefined
      ? [...ISOLATED_BLOCK_LABELS]
      : ISOLATED_BLOCK_LABELS.filter((label) =>
          initBlocks.includes(label as string),
        );

  if (specifiedConversationId) {
    // User specified a conversation to resume
    try {
      await client.conversations.retrieve(specifiedConversationId);
      conversationId = specifiedConversationId;
    } catch {
      console.error(`Error: Conversation ${specifiedConversationId} not found`);
      process.exit(1);
    }
  } else if (shouldContinue) {
    // Try to resume the last conversation for this agent
    await settingsManager.loadLocalProjectSettings();
    const lastSession =
      settingsManager.getLocalLastSession(process.cwd()) ??
      settingsManager.getGlobalLastSession();

    if (lastSession && lastSession.agentId === agent.id) {
      // Verify the conversation still exists
      try {
        await client.conversations.retrieve(lastSession.conversationId);
        conversationId = lastSession.conversationId;
      } catch {
        // Conversation no longer exists, create new
        const conversation = await client.conversations.create({
          agent_id: agent.id,
          isolated_block_labels: isolatedBlockLabels,
        });
        conversationId = conversation.id;
      }
    } else {
      // No matching session, create new conversation
      const conversation = await client.conversations.create({
        agent_id: agent.id,
        isolated_block_labels: isolatedBlockLabels,
      });
      conversationId = conversation.id;
    }
  } else {
    // Default: create a new conversation
    // This ensures isolated message history per CLI invocation
    const conversation = await client.conversations.create({
      agent_id: agent.id,
      isolated_block_labels: isolatedBlockLabels,
    });
    conversationId = conversation.id;
  }
  markMilestone("HEADLESS_CONVERSATION_READY");

  // Save session (agent + conversation) to both project and global settings
  // Skip for subagents - they shouldn't pollute the LRU settings
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
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

  // Ensure the agent has the required skills blocks (for backwards compatibility)
  const createdBlocks = await ensureSkillsBlocks(agent.id);
  if (createdBlocks.length > 0) {
    console.log("Created missing skills blocks for agent compatibility");
  }

  // Set agent context for tools that need it (e.g., Skill tool, Task tool)
  setAgentContext(agent.id, skillsDirectory);
  await initializeLoadedSkillsFlag();

  // Re-discover skills and update the skills memory block
  // This ensures new skills added after agent creation are available
  try {
    const { discoverSkills, formatSkillsForMemory, SKILLS_DIR } = await import(
      "./agent/skills"
    );
    const { join } = await import("node:path");

    const resolvedSkillsDirectory =
      skillsDirectory || join(process.cwd(), SKILLS_DIR);
    const { skills, errors } = await discoverSkills(resolvedSkillsDirectory);

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

  // If input-format is stream-json, use bidirectional mode
  if (isBidirectionalMode) {
    await runBidirectionalMode(
      agent,
      conversationId,
      client,
      outputFormat,
      includePartialMessages,
    );
    return;
  }

  // Create buffers to accumulate stream
  const buffers = createBuffers();

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
      tools:
        agent.tools?.map((t) => t.name).filter((n): n is string => !!n) || [],
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
        resume = await getResumeData(client, freshAgent);
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

      const decisions: Decision[] = [];

      for (const currentApproval of pendingApprovals) {
        const { toolName, toolArgs } = currentApproval;
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          toolArgs || "{}",
          {},
        );
        const permission = await checkToolPermission(toolName, parsedArgs);

        if (permission.decision === "deny" || permission.decision === "ask") {
          const denyReason =
            permission.decision === "ask"
              ? "Tool requires approval (headless mode)"
              : `Permission denied: ${permission.matchedRule || permission.reason}`;
          decisions.push({
            type: "deny",
            approval: currentApproval,
            reason: denyReason,
          });
          continue;
        }

        // Verify required args present; if missing, deny so the model retries with args
        const { getToolSchema } = await import("./tools/manager");
        const schema = getToolSchema(toolName);
        const required =
          (schema?.input_schema?.required as string[] | undefined) || [];
        const missing = required.filter(
          (key) => !(key in parsedArgs) || parsedArgs[key] == null,
        );
        if (missing.length > 0) {
          decisions.push({
            type: "deny",
            approval: currentApproval,
            reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
          });
          continue;
        }

        // Approve for execution
        decisions.push({
          type: "approve",
          approval: currentApproval,
          reason: permission.reason || "Allowed by permission rule",
          matchedRule: permission.matchedRule || "auto-approved",
        });
      }

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

      // Send the approval to clear the pending state; drain the stream without output
      const approvalStream = await sendMessageStream(conversationId, [
        approvalInput,
      ]);
      if (outputFormat === "stream-json") {
        // Consume quickly but don't emit message frames to stdout
        for await (const _ of approvalStream) {
          // no-op
        }
      } else {
        await drainStreamWithResume(approvalStream, createBuffers(), () => {});
      }
    }
  };

  // Clear any pending approvals before starting a new turn - ONLY when resuming (LET-7101)
  // For new agents/conversations, lazy recovery handles any edge cases
  if (isResumingAgent) {
    await resolveAllPendingApprovals();
  }

  // Build message content with reminders (plan mode first, then skill unload)
  const { permissionMode } = await import("./permissions/mode");
  const { hasLoadedSkills } = await import("./agent/context");
  let messageContent = "";

  // Add plan mode reminder if in plan mode (highest priority)
  if (permissionMode.getMode() === "plan") {
    const { PLAN_MODE_REMINDER } = await import("./agent/promptAssets");
    messageContent += PLAN_MODE_REMINDER;
  }

  // Add skill unload reminder if skills are loaded (using cached flag)
  if (hasLoadedSkills()) {
    const { SKILL_UNLOAD_REMINDER } = await import("./agent/promptAssets");
    messageContent += SKILL_UNLOAD_REMINDER;
  }

  // Add user prompt
  messageContent += prompt;

  // Start with the user message
  let currentInput: Array<MessageCreate | ApprovalCreate> = [
    {
      role: "user",
      content: [{ type: "text", text: messageContent }],
    },
  ];

  // Track lastRunId outside the while loop so it's available in catch block
  let lastKnownRunId: string | null = null;
  let llmApiErrorRetries = 0;

  markMilestone("HEADLESS_FIRST_STREAM_START");
  measureSinceMilestone("headless-setup-total", "HEADLESS_CLIENT_READY");

  try {
    while (true) {
      const stream = await sendMessageStream(conversationId, currentInput);

      // For stream-json, output each chunk as it arrives
      let stopReason: StopReasonType | null = null;
      let approvals: Array<{
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      }> = [];
      let apiDurationMs: number;
      let lastRunId: string | null = null;

      if (outputFormat === "stream-json") {
        const startTime = performance.now();

        // Track approval requests across streamed chunks
        const autoApprovalEmitted = new Set<string>();

        const streamProcessor = new StreamProcessor();

        for await (const chunk of stream) {
          const { shouldOutput, errorInfo, updatedApproval } =
            streamProcessor.processChunk(chunk);

          // Detect mid-stream errors
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

            // Still accumulate for tracking
            const { onChunk: accumulatorOnChunk } = await import(
              "./cli/helpers/accumulator"
            );
            accumulatorOnChunk(buffers, chunk);
            continue;
          }

          // Detect server conflict due to pending approval; handle it and retry
          // Check both detail and message fields since error formats vary
          if (
            isApprovalPendingError(errorInfo?.detail) ||
            isApprovalPendingError(errorInfo?.message)
          ) {
            // Emit recovery message for stream-json mode (enables testing)
            if (outputFormat === "stream-json") {
              const recoveryMsg: RecoveryMessage = {
                type: "recovery",
                recovery_type: "approval_pending",
                message:
                  "Detected pending approval conflict; auto-denying stale approval and retrying",
                run_id: lastRunId ?? undefined,
                session_id: sessionId,
                uuid: `recovery-${lastRunId || crypto.randomUUID()}`,
              };
              console.log(JSON.stringify(recoveryMsg));
            }
            // Clear approvals and retry outer loop
            await resolveAllPendingApprovals();
            // Reset state and restart turn
            stopReason = "error" as StopReasonType;
            break;
          }

          // Check if we should skip outputting approval requests in bypass mode
          let shouldOutputChunk = shouldOutput;

          // Check if this approval will be auto-approved. Dedup per tool_call_id
          if (
            updatedApproval &&
            !autoApprovalEmitted.has(updatedApproval.toolCallId) &&
            updatedApproval.toolName
          ) {
            const parsedArgs = safeJsonParseOr<Record<string, unknown> | null>(
              updatedApproval.toolArgs || "{}",
              null,
            );
            const permission = await checkToolPermission(
              updatedApproval.toolName,
              parsedArgs || {},
            );
            if (permission.decision === "allow" && parsedArgs) {
              // Only emit auto_approval if we already have all required params
              const { getToolSchema } = await import("./tools/manager");
              const schema = getToolSchema(updatedApproval.toolName);
              const required =
                (schema?.input_schema?.required as string[] | undefined) || [];
              const missing = required.filter(
                (key) =>
                  !(key in parsedArgs) ||
                  (parsedArgs as Record<string, unknown>)[key] == null,
              );
              if (missing.length === 0) {
                shouldOutputChunk = false;
                const autoApprovalMsg: AutoApprovalMessage = {
                  type: "auto_approval",
                  tool_call: {
                    name: updatedApproval.toolName,
                    tool_call_id: updatedApproval.toolCallId,
                    arguments: updatedApproval.toolArgs || "{}",
                  },
                  reason: permission.reason || "Allowed by permission rule",
                  matched_rule: permission.matchedRule || "auto-approved",
                  session_id: sessionId,
                  uuid: `auto-approval-${updatedApproval.toolCallId}`,
                };
                console.log(JSON.stringify(autoApprovalMsg));
                autoApprovalEmitted.add(updatedApproval.toolCallId);
              }
            }
          }

          // Output chunk as message event (unless filtered)
          if (shouldOutputChunk) {
            // Use existing otid or id from the Letta SDK chunk
            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const uuid = chunkWithIds.otid || chunkWithIds.id;

            if (includePartialMessages) {
              // Emit as stream_event wrapper (like Claude Code with --include-partial-messages)
              const streamEvent: StreamEvent = {
                type: "stream_event",
                event: chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(streamEvent));
            } else {
              // Emit as regular message (default)
              const msg: MessageWire = {
                type: "message",
                ...chunk,
                session_id: sessionId,
                uuid: uuid || crypto.randomUUID(),
              };
              console.log(JSON.stringify(msg));
            }
          }

          // Still accumulate for approval tracking
          const { onChunk } = await import("./cli/helpers/accumulator");
          onChunk(buffers, chunk);
        }

        stopReason = stopReason || streamProcessor.stopReason || "error";
        apiDurationMs = performance.now() - startTime;
        approvals = streamProcessor.getApprovals();
        // Use the last run_id we saw (if any)
        lastRunId = streamProcessor.lastRunId;
        if (lastRunId) lastKnownRunId = lastRunId;

        // Mark final line as finished
        const { markCurrentLineAsFinished } = await import(
          "./cli/helpers/accumulator"
        );
        markCurrentLineAsFinished(buffers);
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

      // Case 1: Turn ended normally
      if (stopReason === "end_turn") {
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

        const decisions: Decision[] = [];

        for (const currentApproval of approvals) {
          const { toolName, toolArgs } = currentApproval;

          // Check permission using existing permission system
          const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
            toolArgs,
            {},
          );
          const permission = await checkToolPermission(toolName, parsedArgs);

          // Handle deny decision
          if (permission.decision === "deny") {
            const denyReason = `Permission denied: ${permission.matchedRule || permission.reason}`;
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: denyReason,
            });
            continue;
          }

          // Handle ask decision - in headless mode, auto-deny
          if (permission.decision === "ask") {
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: "Tool requires approval (headless mode)",
            });
            continue;
          }

          // Permission is "allow" - verify we have required arguments before executing
          const { getToolSchema } = await import("./tools/manager");
          const schema = getToolSchema(toolName);
          const required =
            (schema?.input_schema?.required as string[] | undefined) || [];
          const missing = required.filter(
            (key) => !(key in parsedArgs) || parsedArgs[key] == null,
          );
          if (missing.length > 0) {
            // Auto-deny with a clear reason so the model can retry with arguments
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
            });
            continue;
          }

          // Approve this tool for execution
          decisions.push({
            type: "approve",
            approval: currentApproval,
          });
        }

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

      // Detect approval desync once per turn
      const detailFromRun = await fetchRunErrorDetail(lastRunId);
      const approvalDesynced =
        currentInput.length === 1 &&
        currentInput[0]?.type === "approval" &&
        (isApprovalStateDesyncError(detailFromRun) ||
          isApprovalStateDesyncError(latestErrorText));

      // Track last failure text for emitting on exit
      const lastFailureText =
        latestErrorText ||
        detailFromRun ||
        (lastRunId
          ? `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`
          : `An error occurred during agent execution\n(stop_reason: ${stopReason})`);

      // Case 3: Transient LLM API error - retry with exponential backoff up to a limit
      if (stopReason === "llm_api_error") {
        const shouldUseApprovalRecovery = approvalDesynced;

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
            const recoveryNote = shouldUseApprovalRecovery
              ? " (approval state desynced - sending keep-going prompt)"
              : "";
            console.error(
              `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...${recoveryNote}`,
            );
          }

          // Exponential backoff before retrying the same input
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          if (shouldUseApprovalRecovery) {
            currentInput = [buildApprovalRecoveryMessage()];
          }
          continue;
        }
      }

      // Fallback: if we were sending only approvals and hit an internal error that
      // says there is no pending approval, resend using the keep-alive recovery prompt.
      if (approvalDesynced) {
        if (llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          llmApiErrorRetries += 1;

          const retryReason = stopReason ?? "error";
          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: retryReason,
              attempt: llmApiErrorRetries,
              max_attempts: LLM_API_ERROR_MAX_RETRIES,
              delay_ms: 0,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `retry-${lastRunId || crypto.randomUUID()}`,
            };
            console.log(JSON.stringify(retryMsg));
          } else {
            console.error(
              "Approval state desynced; resending keep-alive recovery prompt...",
            );
          }

          // Small pause to avoid rapid-fire retries
          await new Promise((resolve) => setTimeout(resolve, 250));

          currentInput = [buildApprovalRecoveryMessage()];
          continue;
        }

        // No retries left or non-retriable: emit error and exit
        if (outputFormat === "stream-json") {
          const errorMsg: ErrorMessage = {
            type: "error",
            message: lastFailureText,
            stop_reason: stopReason,
            run_id: lastRunId ?? undefined,
            session_id: sessionId,
            uuid: `error-${lastRunId || crypto.randomUUID()}`,
          };
          console.log(JSON.stringify(errorMsg));
        } else {
          console.error(lastFailureText);
        }
        process.exit(1);
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

          if (errorType === "llm_error" || isLlmErrorFromDetail) {
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
      markIncompleteToolsAsCancelled(buffers);

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
    markIncompleteToolsAsCancelled(buffers);

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
  _client: Letta,
  _outputFormat: string,
  includePartialMessages: boolean,
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
    tools: agent.tools?.map((t) => t.name) || [],
    cwd: process.cwd(),
    uuid: `init-${agent.id}`,
  };
  console.log(JSON.stringify(initEvent));

  // Track current operation for interrupt support
  let currentAbortController: AbortController | null = null;

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
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
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

    // Wait for control_response
    while (true) {
      const line = await getNextLine();
      if (line === null) {
        return { decision: "deny", reason: "stdin closed" };
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
            return { decision: "deny", reason: "Invalid response format" };
          }

          if (response.behavior === "allow") {
            return { decision: "allow" };
          } else {
            return {
              decision: "deny",
              reason: response.message,
              // TODO: handle interrupt flag
            };
          }
        }
        // Put other messages back in queue for main loop
        lineQueue.unshift(line);
        // But since we're waiting for permission, we need to wait more
        // Actually this causes issues - let's just ignore other messages
        // during permission wait (they'll be lost)
      } catch {
        // Ignore parse errors
      }
    }
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
              tools: agent.tools?.map((t) => t.name) || [],
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
        const buffers = createBuffers();
        const startTime = performance.now();
        let numTurns = 0;

        // Initial input is the user message
        let currentInput: MessageCreate[] = [
          { role: "user", content: userContent },
        ];

        // Approval handling loop - continue until end_turn or error
        while (true) {
          numTurns++;

          // Check if aborted
          if (currentAbortController?.signal.aborted) {
            break;
          }

          // Send message to agent
          const stream = await sendMessageStream(conversationId, currentInput);

          const streamProcessor = new StreamProcessor();

          // Process stream
          for await (const chunk of stream) {
            // Check if aborted
            if (currentAbortController?.signal.aborted) {
              break;
            }

            // Process chunk through StreamProcessor
            const { shouldOutput } = streamProcessor.processChunk(chunk);

            // Output chunk if not suppressed
            if (shouldOutput) {
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

            // Accumulate for result
            const { onChunk } = await import("./cli/helpers/accumulator");
            onChunk(buffers, chunk);
          }

          // Get stop reason from processor
          const stopReason = streamProcessor.stopReason || "error";

          // Case 1: Turn ended normally - break out of loop
          if (stopReason === "end_turn") {
            break;
          }

          // Case 2: Aborted - break out of loop
          if (currentAbortController?.signal.aborted) {
            break;
          }

          // Case 3: Requires approval - process approvals and continue
          if (stopReason === "requires_approval") {
            const approvals = streamProcessor.getApprovals();

            if (approvals.length === 0) {
              // No approvals to process - break
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

            const decisions: Decision[] = [];

            for (const approval of approvals) {
              const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
                approval.toolArgs,
                {},
              );
              const permission = await checkToolPermission(
                approval.toolName,
                parsedArgs,
              );

              if (permission.decision === "allow") {
                decisions.push({
                  type: "approve",
                  approval,
                  matchedRule: permission.matchedRule || "auto-approved",
                });

                // Emit auto_approval event
                const autoApprovalMsg: AutoApprovalMessage = {
                  type: "auto_approval",
                  tool_call: {
                    name: approval.toolName,
                    tool_call_id: approval.toolCallId,
                    arguments: approval.toolArgs,
                  },
                  reason: permission.reason || "auto-approved",
                  matched_rule: permission.matchedRule || "auto-approved",
                  session_id: sessionId,
                  uuid: `auto-approval-${approval.toolCallId}`,
                };
                console.log(JSON.stringify(autoApprovalMsg));
              } else if (permission.decision === "deny") {
                // Explicitly denied by permission rules
                decisions.push({
                  type: "deny",
                  approval,
                  reason: `Permission denied: ${permission.matchedRule || permission.reason}`,
                });
              } else {
                // permission.decision === "ask" - request permission from SDK
                const permResponse = await requestPermission(
                  approval.toolCallId,
                  approval.toolName,
                  parsedArgs,
                );

                if (permResponse.decision === "allow") {
                  decisions.push({
                    type: "approve",
                    approval,
                    matchedRule: "SDK callback approved",
                  });

                  // Emit auto_approval event for SDK-approved tool
                  const autoApprovalMsg: AutoApprovalMessage = {
                    type: "auto_approval",
                    tool_call: {
                      name: approval.toolName,
                      tool_call_id: approval.toolCallId,
                      arguments: approval.toolArgs,
                    },
                    reason: permResponse.reason || "SDK callback approved",
                    matched_rule: "canUseTool callback",
                    session_id: sessionId,
                    uuid: `auto-approval-${approval.toolCallId}`,
                  };
                  console.log(JSON.stringify(autoApprovalMsg));
                } else {
                  decisions.push({
                    type: "deny",
                    approval,
                    reason: permResponse.reason || "Denied by SDK callback",
                  });
                }
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

        const resultMsg: ResultMessage = {
          type: "result",
          subtype: currentAbortController?.signal.aborted
            ? "interrupted"
            : "success",
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
        };
        console.log(JSON.stringify(resultMsg));
      } catch (error) {
        const errorMsg: ErrorMessage = {
          type: "error",
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
          stop_reason: "error",
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        };
        console.log(JSON.stringify(errorMsg));
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
