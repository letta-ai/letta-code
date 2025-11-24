import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../agent/modify";
import { toolFilter } from "./filter";
import {
  clearTools,
  getToolNames,
  isOpenAIModel,
  loadTools,
  upsertToolsToServer,
} from "./manager";

/**
 * Switches the loaded toolset based on the target model identifier,
 * upserts the tools to the server, and relinks them to the agent.
 *
 * @param modelIdentifier - The model handle/id
 * @param agentId - Agent to relink tools to
 * @param onNotice - Optional callback to emit a transcript notice
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  agentId: string,
): Promise<"codex" | "default"> {
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

  // Upsert the new toolset (stored in the tool registry) to server
  const client = await getClient();
  await upsertToolsToServer(client);

  // Remove old Letta tools and add new ones
  await unlinkToolsFromAgent(agentId);
  await linkToolsToAgent(agentId);

  const toolsetName = isOpenAIModel(resolvedModel) ? "codex" : "default";
  return toolsetName;
}
