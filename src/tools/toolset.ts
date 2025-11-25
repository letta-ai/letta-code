import type Letta from "@letta-ai/letta-client";
import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../agent/modify";
import { toolFilter } from "./filter";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearTools,
  GEMINI_DEFAULT_TOOLS,
  getToolNames,
  isOpenAIModel,
  loadTools,
  OPENAI_DEFAULT_TOOLS,
  upsertToolsToServer,
} from "./manager";

// Use the same toolset definitions from manager.ts (single source of truth)
const ANTHROPIC_TOOLS = ANTHROPIC_DEFAULT_TOOLS;
const CODEX_TOOLS = OPENAI_DEFAULT_TOOLS;
const GEMINI_TOOLS = GEMINI_DEFAULT_TOOLS;

/**
 * Gets the list of Letta Code tools currently attached to an agent.
 * Returns the tool names that are both attached to the agent AND in our tool definitions.
 */
export async function getAttachedLettaTools(
  client: Letta,
  agentId: string,
): Promise<string[]> {
  const agent = await client.agents.retrieve(agentId, {
    include: ["agent.tools"],
  });

  const toolNames =
    agent.tools
      ?.map((t) => t.name)
      .filter((name): name is string => typeof name === "string") || [];

  // Get all possible Letta Code tool names
  const allLettaTools: string[] = [
    ...CODEX_TOOLS,
    ...ANTHROPIC_TOOLS,
    ...GEMINI_TOOLS,
  ];

  // Return intersection: tools that are both attached AND in our definitions
  return toolNames.filter((name) => allLettaTools.includes(name));
}

/**
 * Detects which toolset is attached to an agent by examining its tools.
 * Returns "codex", "default", "gemini" based on majority, or null if no Letta Code tools.
 */
export async function detectToolsetFromAgent(
  client: Letta,
  agentId: string,
): Promise<"codex" | "default" | "gemini" | null> {
  const attachedTools = await getAttachedLettaTools(client, agentId);

  if (attachedTools.length === 0) {
    return null;
  }

  const codexToolNames: string[] = [...CODEX_TOOLS];
  const anthropicToolNames: string[] = [...ANTHROPIC_TOOLS];
  const geminiToolNames: string[] = [...GEMINI_TOOLS];

  const codexCount = attachedTools.filter((name) =>
    codexToolNames.includes(name),
  ).length;
  const anthropicCount = attachedTools.filter((name) =>
    anthropicToolNames.includes(name),
  ).length;
  const geminiCount = attachedTools.filter((name) =>
    geminiToolNames.includes(name),
  ).length;

  // Return whichever has the most tools attached
  const max = Math.max(codexCount, anthropicCount, geminiCount);
  if (geminiCount === max) return "gemini";
  if (codexCount === max) return "codex";
  return "default";
}

/**
 * Force switch to a specific toolset regardless of model.
 *
 * @param toolsetName - The toolset to switch to ("codex", "default", or "gemini")
 * @param agentId - Agent to relink tools to
 */
export async function forceToolsetSwitch(
  toolsetName: "codex" | "default" | "gemini",
  agentId: string,
): Promise<void> {
  // Clear currently loaded tools
  clearTools();

  // Load the appropriate toolset by passing a model identifier from that provider
  if (toolsetName === "codex") {
    await loadTools("openai/gpt-4");
  } else if (toolsetName === "gemini") {
    await loadTools("google_ai/gemini-3-pro-preview");
  } else {
    await loadTools("anthropic/claude-sonnet-4");
  }

  // Upsert the new toolset to server
  const client = await getClient();
  await upsertToolsToServer(client);

  // Remove old Letta tools and add new ones
  await unlinkToolsFromAgent(agentId);
  await linkToolsToAgent(agentId);
}

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
): Promise<"codex" | "default" | "gemini"> {
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

  const { isGeminiModel } = await import("./manager");
  const toolsetName = isOpenAIModel(resolvedModel)
    ? "codex"
    : isGeminiModel(resolvedModel)
      ? "gemini"
      : "default";
  return toolsetName;
}
