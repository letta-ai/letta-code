/**
 * Utilities for creating an agent on the Letta API backend
 **/

import type {
  AgentState,
  AgentType,
} from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "../backend/api/client";
import { apiRequest, getApiRequestConfig } from "../backend/api/request";
import { DEFAULT_AGENT_NAME, DEFAULT_SUMMARIZATION_MODEL } from "../constants";
import { settingsManager } from "../settings-manager";
import { getModelContextWindow } from "./available-models";
import { getDefaultMemoryBlocks } from "./memory";
import {
  formatAvailableModels,
  getDefaultModel,
  getModelUpdateArgs,
  resolveModel,
} from "./model";
import { updateAgentLLMConfig } from "./modify";
import {
  isKnownPreset,
  type MemoryPromptMode,
  resolveAndBuildSystemPrompt,
  resolveSystemPrompt,
  SLEEPTIME_MEMORY_PERSONA,
  swapMemoryAddon,
} from "./promptAssets";

/**
 * Describes where a memory block came from
 */
export interface BlockProvenance {
  label: string;
  source: "global" | "project" | "new" | "shared";
}

/**
 * Provenance info for an agent creation
 */
export interface AgentProvenance {
  isNew: true;
  blocks: BlockProvenance[];
}

/**
 * Result from createAgent including provenance info
 */
export interface CreateAgentResult {
  agent: AgentState;
  provenance: AgentProvenance;
}

function isToolsNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;

  return (
    typeof message === "string" &&
    /tools not found by name/i.test(message) &&
    /memory_apply_patch|memory|web_search|fetch_webpage/i.test(message) &&
    (status === undefined || status === 400)
  );
}

export async function addBaseToolsToServer(): Promise<boolean> {
  const { apiKey } = await getApiRequestConfig();

  if (!apiKey) {
    console.warn(
      "Cannot auto-populate base tools: missing LETTA_API_KEY for manual endpoint call.",
    );
    return false;
  }

  try {
    await apiRequest<void>("POST", "/v1/tools/add-base-tools");
    return true;
  } catch (err) {
    console.warn(
      `Failed to call /v1/tools/add-base-tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

type CreateWithToolsFn = (tools: string[]) => Promise<AgentState>;
type AddBaseToolsFn = () => Promise<boolean>;

export async function createAgentWithBaseToolsRecovery(
  createWithTools: CreateWithToolsFn,
  toolNames: string[],
  addBaseTools: AddBaseToolsFn = addBaseToolsToServer,
): Promise<AgentState> {
  try {
    return await createWithTools(toolNames);
  } catch (err) {
    if (!isToolsNotFoundError(err)) {
      throw err;
    }

    console.warn(
      "Agent creation failed due to missing base tools. Attempting to add base tools on server...",
    );
    await addBaseTools();

    try {
      return await createWithTools(toolNames);
    } catch (retryErr) {
      console.warn(
        `Agent creation still failed after base-tool bootstrap: ${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }`,
      );
      console.warn(
        "Retrying agent creation with no server-side tools attached.",
      );
      return await createWithTools([]);
    }
  }
}

export interface CreateAgentOptions {
  name?: string;
  /** Agent description shown in /agents selector */
  description?: string;
  model?: string;
  embeddingModel?: string;
  updateArgs?: Record<string, unknown>;
  skillsDirectory?: string;
  parallelToolCalls?: boolean;
  enableSleeptime?: boolean;
  /** System prompt preset (e.g., 'default', 'letta', 'source-claude') */
  systemPromptPreset?: string;
  /** Raw system prompt string (mutually exclusive with systemPromptPreset) */
  systemPromptCustom?: string;
  /** Which managed memory prompt mode to apply */
  memoryPromptMode?: MemoryPromptMode;
  /** Block labels to initialize (from default blocks) */
  initBlocks?: string[];
  /** Base tools to include */
  baseTools?: string[];
  /** Custom memory blocks (overrides default blocks) */
  memoryBlocks?: Array<
    { label: string; value: string; description?: string } | { blockId: string }
  >;
  /** Override values for preset blocks (label → value) */
  blockValues?: Record<string, string>;
  /** Tags to organize and categorize the agent */
  tags?: string[];
}

export async function createAgent(
  nameOrOptions: string | CreateAgentOptions = DEFAULT_AGENT_NAME,
  model?: string,
  embeddingModel?: string,
  updateArgs?: Record<string, unknown>,
  skillsDirectory?: string,
  parallelToolCalls = true,
  enableSleeptime = false,
  systemPromptPreset?: string,
  initBlocks?: string[],
  baseTools?: string[],
) {
  // Support both old positional args and new options object
  let options: CreateAgentOptions;
  if (typeof nameOrOptions === "object") {
    options = nameOrOptions;
  } else {
    options = {
      name: nameOrOptions,
      model,
      embeddingModel,
      updateArgs,
      skillsDirectory,
      parallelToolCalls,
      enableSleeptime,
      systemPromptPreset,
      initBlocks,
      baseTools,
    };
  }

  const name = options.name ?? DEFAULT_AGENT_NAME;
  const embeddingModelVal = options.embeddingModel;
  const parallelToolCallsVal = options.parallelToolCalls ?? true;
  const enableSleeptimeVal = options.enableSleeptime ?? false;

  // Resolve model identifier to handle
  let modelHandle: string;
  if (options.model) {
    const resolved = resolveModel(options.model);
    if (!resolved) {
      const availableModels = formatAvailableModels();
      console.error(`Error: Unknown model "${options.model}"`);
      console.error("Available models:");
      console.error(availableModels);
      throw new Error(`Unknown model "${options.model}".`);
    }
    modelHandle = resolved;
  } else {
    // Use default model from models.json
    modelHandle = getDefaultModel();
  }

  const client = await getClient();

  // Only attach server-side tools to the agent.
  // Client-side tools (Read, Write, Bash, etc.) are passed via client_tools at runtime,
  // NOT attached to the agent. This is the new pattern - no more stub tool registration.
  const defaultBaseTools = options.baseTools ?? ["web_search", "fetch_webpage"];
  const toolNames = [...defaultBaseTools];

  // Determine which memory blocks to use:
  // 1. If options.memoryBlocks is provided, use those (custom blocks and/or block references)
  // 2. Otherwise, use default blocks filtered by options.initBlocks

  // Separate block references from blocks to create
  const referencedBlockIds: string[] = [];
  let filteredMemoryBlocks: Array<{
    label: string;
    value: string;
    description?: string | null;
    limit?: number;
  }>;

  if (options.memoryBlocks !== undefined) {
    // Separate blockId references from CreateBlock items
    const createBlocks: typeof filteredMemoryBlocks = [];
    for (const item of options.memoryBlocks) {
      if ("blockId" in item) {
        referencedBlockIds.push(item.blockId);
      } else {
        createBlocks.push(item as (typeof filteredMemoryBlocks)[0]);
      }
    }
    filteredMemoryBlocks = createBlocks;
  } else {
    // Load memory blocks from .mdx files
    const defaultMemoryBlocks =
      options.initBlocks && options.initBlocks.length === 0
        ? []
        : await getDefaultMemoryBlocks();

    // Optional filter: only initialize a subset of memory blocks on creation
    const allowedBlockLabels = options.initBlocks
      ? new Set(
          options.initBlocks.map((n) => n.trim()).filter((n) => n.length > 0),
        )
      : undefined;

    if (allowedBlockLabels && allowedBlockLabels.size > 0) {
      const knownLabels = new Set(defaultMemoryBlocks.map((b) => b.label));
      for (const label of Array.from(allowedBlockLabels)) {
        if (!knownLabels.has(label)) {
          console.warn(
            `Ignoring unknown init block "${label}". Valid blocks: ${Array.from(knownLabels).join(", ")}`,
          );
          allowedBlockLabels.delete(label);
        }
      }
    }

    filteredMemoryBlocks =
      allowedBlockLabels && allowedBlockLabels.size > 0
        ? defaultMemoryBlocks.filter((b) => allowedBlockLabels.has(b.label))
        : defaultMemoryBlocks;
  }

  // Apply blockValues overrides to preset blocks
  if (options.blockValues) {
    for (const [label, value] of Object.entries(options.blockValues)) {
      const block = filteredMemoryBlocks.find((b) => b.label === label);
      if (block) {
        block.value = value;
      } else {
        console.warn(
          `Ignoring --block-value for "${label}" - block not included in memory config`,
        );
      }
    }
  }

  // Track provenance: which blocks were created
  // Note: We no longer reuse shared blocks - each agent gets fresh blocks
  const blockProvenance: BlockProvenance[] = [];

  // Mark new blocks for provenance tracking (actual creation happens in agents.create)
  for (const block of filteredMemoryBlocks) {
    blockProvenance.push({ label: block.label, source: "new" });
  }

  // Mark referenced blocks for provenance tracking
  for (const blockId of referencedBlockIds) {
    blockProvenance.push({ label: blockId, source: "shared" });
  }

  // Get the model's context window from its configuration (if known).
  // If the caller specified a model *ID* (e.g. gpt-5.3-codex-plus-pro-high),
  // use that identifier to preserve tier-specific updateArgs like reasoning_effort.
  // Otherwise, fall back to the resolved handle.
  const modelIdentifierForDefaults = options.model ?? modelHandle;
  const modelUpdateArgs = options.model
    ? getModelUpdateArgs(modelIdentifierForDefaults)
    : undefined;
  const contextWindow =
    (modelUpdateArgs?.context_window as number | undefined) ??
    (await getModelContextWindow(modelHandle));

  // Resolve system prompt content
  const memMode: MemoryPromptMode = options.memoryPromptMode ?? "standard";
  const disableManagedMemoryPrompt =
    Array.isArray(options.initBlocks) && options.initBlocks.length === 0;
  const systemPromptContent = disableManagedMemoryPrompt
    ? (options.systemPromptCustom ??
      (await resolveSystemPrompt(options.systemPromptPreset)))
    : options.systemPromptCustom
      ? swapMemoryAddon(options.systemPromptCustom, memMode)
      : await resolveAndBuildSystemPrompt(options.systemPromptPreset, memMode);

  // Create agent with inline memory blocks (LET-7101: single API call instead of N+1)
  // - memory_blocks: new blocks to create inline
  // - block_ids: references to existing blocks (for shared memory)
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
  const tags = ["origin:letta-code"];
  if (isSubagent) {
    tags.push("role:subagent");
  }
  if (options.tags && Array.isArray(options.tags)) {
    tags.push(...options.tags);
  }

  const agentDescription =
    options.description ?? `Letta Code agent created in ${process.cwd()}`;

  const createAgentRequestBase = {
    agent_type: "letta_v1_agent" as AgentType,
    system: systemPromptContent,
    name,
    description: agentDescription,
    embedding: embeddingModelVal || undefined,
    model: modelHandle,
    ...(contextWindow && { context_window_limit: contextWindow }),
    // New blocks created inline with agent (saves ~2s of sequential API calls)
    memory_blocks:
      filteredMemoryBlocks.length > 0 ? filteredMemoryBlocks : undefined,
    // Referenced block IDs (existing blocks to attach)
    block_ids: referencedBlockIds.length > 0 ? referencedBlockIds : undefined,
    tags,
    ...(isSubagent && { hidden: true }),
    // should be default off, but just in case
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: parallelToolCallsVal,
    enable_sleeptime: enableSleeptimeVal,
    compaction_settings: {
      model: DEFAULT_SUMMARIZATION_MODEL,
    },
  };

  const createWithTools = (tools: string[]) =>
    client.agents.create({
      ...createAgentRequestBase,
      tools,
    });

  const agent = await createAgentWithBaseToolsRecovery(
    createWithTools,
    toolNames,
    addBaseToolsToServer,
  );

  // Apply updateArgs if provided (e.g., context_window, reasoning_effort, verbosity, etc.).
  // Also apply tier defaults from models.json when the caller explicitly selected a model.
  //
  // Note: we intentionally pass context_window through so updateAgentLLMConfig can set
  // context_window_limit using the latest server API, avoiding any fallback.
  const mergedUpdateArgs = {
    ...(modelUpdateArgs ?? {}),
    ...(options.updateArgs ?? {}),
  };
  if (Object.keys(mergedUpdateArgs).length > 0) {
    await updateAgentLLMConfig(agent.id, modelHandle, mergedUpdateArgs);
  }

  // Always retrieve the agent to ensure we get the full state with populated memory blocks
  const fullAgent = await client.agents.retrieve(agent.id, {
    include: ["agent.managed_group"],
  });

  // Update persona block for sleeptime agent
  if (enableSleeptimeVal && fullAgent.managed_group) {
    // Find the sleeptime agent in the managed group by checking agent_type
    for (const groupAgentId of fullAgent.managed_group.agent_ids) {
      try {
        const groupAgent = await client.agents.retrieve(groupAgentId);
        if (groupAgent.agent_type === "sleeptime_agent") {
          // Update the persona block on the SLEEPTIME agent, not the primary agent
          await client.agents.blocks.update("memory_persona", {
            agent_id: groupAgentId,
            value: SLEEPTIME_MEMORY_PERSONA,
            description:
              "Instructions for the sleep-time memory management agent",
          });
          break; // Found and updated sleeptime agent
        }
      } catch (error) {
        console.warn(
          `Failed to check/update agent ${groupAgentId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  // Persist system prompt preset — only for non-subagents and known presets or custom.
  // Guarded by isReady since settings may not be initialized in direct/test callers.
  if (!isSubagent && settingsManager.isReady) {
    if (options.systemPromptCustom) {
      settingsManager.setSystemPromptPreset(fullAgent.id, "custom");
    } else if (isKnownPreset(options.systemPromptPreset ?? "default")) {
      settingsManager.setSystemPromptPreset(
        fullAgent.id,
        options.systemPromptPreset ?? "default",
      );
    }
    // Subagent names: don't persist (no reproducible recipe)
  }

  // Build provenance info
  const provenance: AgentProvenance = {
    isNew: true,
    blocks: blockProvenance,
  };

  return { agent: fullAgent, provenance };
}
