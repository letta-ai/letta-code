import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import { toolFilter } from "./filter";
import {
  clearTools,
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
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

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
 * Force switch to a specific toolset regardless of model.
 *
 * @param toolsetName - The toolset to switch to
 * @param agentId - Agent to relink tools to
 */
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
  agentId: string,
): Promise<void> {
  // Clear currently loaded tools
  clearTools();

  // Load the appropriate toolset
  // Map toolset name to a model identifier for loading
  let modelForLoading: string;
  if (toolsetName === "none") {
    // Just clear tools, no loading needed
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

  // Clear currently loaded tools and load the appropriate set for the target model
  clearTools();
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
