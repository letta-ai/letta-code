import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import { toolFilter } from "./filter";
import {
  clearToolsWithLock,
  GEMINI_PASCAL_TOOLS,
  getToolNames,
  isOpenAIModel,
  loadSpecificTools,
  loadTools,
  OPENAI_PASCAL_TOOLS,
} from "./manager";

// Toolset definitions from manager.ts (single source of truth)
const CODEX_TOOLS = OPENAI_PASCAL_TOOLS;
const GEMINI_TOOLS = GEMINI_PASCAL_TOOLS;

// Toolset type including snake_case variants
export type ToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";

/**
 * Ensures the correct memory tool is attached to the agent based on the model.
 * - OpenAI/Codex models use memory_apply_patch
 * - Claude/Gemini models use memory
 *
 * This is a server-side tool swap - client tools are passed via client_tools per-request.
 *
 * @param agentId - The agent ID to update
 * @param modelIdentifier - Model handle to determine which memory tool to use
 * @param useMemoryPatch - Optional override: true = use memory_apply_patch, false = use memory
 */
export async function ensureCorrectMemoryTool(
  agentId: string,
  modelIdentifier: string,
  useMemoryPatch?: boolean,
): Promise<void> {
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  const client = await getClient();
  const shouldUsePatch =
    useMemoryPatch !== undefined
      ? useMemoryPatch
      : isOpenAIModel(resolvedModel);

  try {
    // Need full agent state for tool_rules, so use retrieve with include
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // If agent has no memory tool at all, don't add one
    // This preserves stateless agents (like Incognito) that intentionally have no memory
    const hasAnyMemoryTool =
      mapByName.has("memory") || mapByName.has("memory_apply_patch");
    if (!hasAnyMemoryTool) {
      return;
    }

    // Determine which memory tool we want
    // Only OpenAI (Codex) uses memory_apply_patch; Claude and Gemini use memory
    const desiredMemoryTool = shouldUsePatch ? "memory_apply_patch" : "memory";
    const otherMemoryTool =
      desiredMemoryTool === "memory" ? "memory_apply_patch" : "memory";

    // Ensure desired memory tool attached
    let desiredId = mapByName.get(desiredMemoryTool);
    if (!desiredId) {
      const resp = await client.tools.list({ name: desiredMemoryTool });
      desiredId = resp.items[0]?.id;
    }
    if (!desiredId) {
      // No warning needed - the tool might not exist on this server
      return;
    }

    const otherId = mapByName.get(otherMemoryTool);

    // Check if swap is needed
    if (mapByName.has(desiredMemoryTool) && !otherId) {
      // Already has the right tool, no swap needed
      return;
    }

    const currentIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const newIds = new Set(currentIds);
    if (otherId) newIds.delete(otherId);
    newIds.add(desiredId);

    const updatedRules = (agentWithTools.tool_rules || []).map((r) =>
      r.tool_name === otherMemoryTool
        ? { ...r, tool_name: desiredMemoryTool }
        : r,
    );

    await client.agents.update(agentId, {
      tool_ids: Array.from(newIds),
      tool_rules: updatedRules,
    });
  } catch (err) {
    console.warn(
      `Warning: Failed to sync memory tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Detach all memory tools from an agent.
 * Used when enabling memfs (filesystem-backed memory).
 *
 * @param agentId - Agent to detach memory tools from
 * @returns true if any tools were detached
 */
export async function detachMemoryTools(agentId: string): Promise<boolean> {
  const client = await getClient();

  try {
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];

    let detachedAny = false;
    for (const tool of currentTools) {
      if (tool.name === "memory" || tool.name === "memory_apply_patch") {
        if (tool.id) {
          await client.agents.tools.detach(tool.id, { agent_id: agentId });
          detachedAny = true;
        }
      }
    }

    return detachedAny;
  } catch (err) {
    console.warn(
      `Warning: Failed to detach memory tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Re-attach the appropriate memory tool to an agent.
 * Used when disabling memfs (filesystem-backed memory).
 * Forces attachment even if agent had no memory tool before.
 *
 * @param agentId - Agent to attach memory tool to
 * @param modelIdentifier - Model handle to determine which memory tool to use
 */
export async function reattachMemoryTool(
  agentId: string,
  modelIdentifier: string,
): Promise<void> {
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  const client = await getClient();
  const shouldUsePatch = isOpenAIModel(resolvedModel);

  try {
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // Determine which memory tool we want
    const desiredMemoryTool = shouldUsePatch ? "memory_apply_patch" : "memory";

    // Already has the tool?
    if (mapByName.has(desiredMemoryTool)) {
      return;
    }

    // Find the tool on the server
    const resp = await client.tools.list({ name: desiredMemoryTool });
    const toolId = resp.items[0]?.id;
    if (!toolId) {
      console.warn(`Memory tool "${desiredMemoryTool}" not found on server`);
      return;
    }

    // Attach it
    await client.agents.tools.attach(toolId, { agent_id: agentId });
  } catch (err) {
    console.warn(
      `Warning: Failed to reattach memory tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Force switch to a specific toolset regardless of model.
 *
 * @param toolsetName - The toolset to switch to
 * @param agentId - Agent to relink tools to
 */
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
  agentId: string,
): Promise<void> {
  // Load the appropriate toolset
  // Note: loadTools/loadSpecificTools acquire a switch lock that causes
  // sendMessageStream to wait, preventing messages from being sent with
  // stale or partial tools during the switch.
  let modelForLoading: string;
  if (toolsetName === "none") {
    // Clear tools with lock protection so sendMessageStream() waits
    clearToolsWithLock();
    return;
  } else if (toolsetName === "codex") {
    await loadSpecificTools([...CODEX_TOOLS]);
    modelForLoading = "openai/gpt-4";
  } else if (toolsetName === "codex_snake") {
    await loadTools("openai/gpt-4");
    modelForLoading = "openai/gpt-4";
  } else if (toolsetName === "gemini") {
    await loadSpecificTools([...GEMINI_TOOLS]);
    modelForLoading = "google_ai/gemini-3-pro-preview";
  } else if (toolsetName === "gemini_snake") {
    await loadTools("google_ai/gemini-3-pro-preview");
    modelForLoading = "google_ai/gemini-3-pro-preview";
  } else {
    await loadTools("anthropic/claude-sonnet-4");
    modelForLoading = "anthropic/claude-sonnet-4";
  }

  // Ensure base memory tool is correct for the toolset
  // Codex uses memory_apply_patch; Claude and Gemini use memory
  const useMemoryPatch =
    toolsetName === "codex" || toolsetName === "codex_snake";
  await ensureCorrectMemoryTool(agentId, modelForLoading, useMemoryPatch);

  // NOTE: Toolset is not persisted. On resume, we derive from agent's model.
  // If we want to persist explicit toolset overrides in the future, add:
  //   agentToolsets: Record<string, ToolsetName> to Settings (global, since agent IDs are UUIDs)
  // and save here: settingsManager.updateSettings({ agentToolsets: { ...current, [agentId]: toolsetName } })
}

/**
 * Switches the loaded toolset based on the target model identifier,
 * and ensures the correct memory tool is attached to the agent.
 *
 * @param modelIdentifier - The model handle/id
 * @param agentId - Agent to relink tools to
 * @param onNotice - Optional callback to emit a transcript notice
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  agentId: string,
): Promise<ToolsetName> {
  // Resolve model ID to handle when possible so provider checks stay consistent
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;

  // Load the appropriate set for the target model
  // Note: loadTools acquires a switch lock that causes sendMessageStream to wait,
  // preventing messages from being sent with stale or partial tools during the switch.
  await loadTools(resolvedModel);

  // If no tools were loaded (e.g., unexpected handle or edge-case filter),
  // fall back to loading the default toolset to avoid ending up with only base tools.
  const loadedAfterPrimary = getToolNames().length;
  if (loadedAfterPrimary === 0 && !toolFilter.isActive()) {
    await loadTools();

    // If we *still* have no tools, surface an explicit error instead of silently
    // leaving the agent with only base tools attached.
    if (getToolNames().length === 0) {
      throw new Error(
        `Failed to load any Letta tools for model "${resolvedModel}".`,
      );
    }
  }

  // Ensure base memory tool is correct for the model
  await ensureCorrectMemoryTool(agentId, resolvedModel);

  const { isGeminiModel } = await import("./manager");
  const toolsetName = isOpenAIModel(resolvedModel)
    ? "codex"
    : isGeminiModel(resolvedModel)
      ? "gemini"
      : "default";

  // NOTE: Toolset is derived from model, not persisted. See comment in forceToolsetSwitch.
  return toolsetName;
}
