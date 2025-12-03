import type Letta from "@letta-ai/letta-client";
import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../agent/modify";
import { toolFilter } from "./filter";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearTools,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  getToolNames,
  isOpenAIModel,
  loadSpecificTools,
  loadTools,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
  upsertToolsToServer,
} from "./manager";

// Use the same toolset definitions from manager.ts (single source of truth)
const ANTHROPIC_TOOLS = ANTHROPIC_DEFAULT_TOOLS;
const CODEX_TOOLS = OPENAI_PASCAL_TOOLS;
const CODEX_SNAKE_TOOLS = OPENAI_DEFAULT_TOOLS;
const GEMINI_TOOLS = GEMINI_PASCAL_TOOLS;
const GEMINI_SNAKE_TOOLS = GEMINI_DEFAULT_TOOLS;

// Toolset type including snake_case variants
export type ToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake";

// Server-side/base tools that should stay attached regardless of Letta toolset
export const BASE_TOOL_NAMES = ["memory", "web_search"];

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
    ...CODEX_SNAKE_TOOLS,
    ...ANTHROPIC_TOOLS,
    ...GEMINI_TOOLS,
    ...GEMINI_SNAKE_TOOLS,
  ];

  // Return intersection: tools that are both attached AND in our definitions
  return toolNames.filter((name) => allLettaTools.includes(name));
}

/**
 * Detects which toolset is attached to an agent by examining its tools.
 * Returns the toolset name based on majority, or null if no Letta Code tools.
 */
export async function detectToolsetFromAgent(
  client: Letta,
  agentId: string,
): Promise<ToolsetName | null> {
  const attachedTools = await getAttachedLettaTools(client, agentId);

  if (attachedTools.length === 0) {
    return null;
  }

  const codexToolNames: string[] = [...CODEX_TOOLS];
  const codexSnakeToolNames: string[] = [...CODEX_SNAKE_TOOLS];
  const anthropicToolNames: string[] = [...ANTHROPIC_TOOLS];
  const geminiToolNames: string[] = [...GEMINI_TOOLS];
  const geminiSnakeToolNames: string[] = [...GEMINI_SNAKE_TOOLS];

  const codexCount = attachedTools.filter((name) =>
    codexToolNames.includes(name),
  ).length;
  const codexSnakeCount = attachedTools.filter((name) =>
    codexSnakeToolNames.includes(name),
  ).length;
  const anthropicCount = attachedTools.filter((name) =>
    anthropicToolNames.includes(name),
  ).length;
  const geminiCount = attachedTools.filter((name) =>
    geminiToolNames.includes(name),
  ).length;
  const geminiSnakeCount = attachedTools.filter((name) =>
    geminiSnakeToolNames.includes(name),
  ).length;

  // Return whichever has the most tools attached
  const max = Math.max(
    codexCount,
    codexSnakeCount,
    anthropicCount,
    geminiCount,
    geminiSnakeCount,
  );
  if (geminiSnakeCount === max) return "gemini_snake";
  if (geminiCount === max) return "gemini";
  if (codexSnakeCount === max) return "codex_snake";
  if (codexCount === max) return "codex";
  return "default";
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
  if (toolsetName === "codex") {
    await loadSpecificTools([...CODEX_TOOLS]);
  } else if (toolsetName === "codex_snake") {
    await loadTools("openai/gpt-4");
  } else if (toolsetName === "gemini") {
    await loadSpecificTools([...GEMINI_TOOLS]);
  } else if (toolsetName === "gemini_snake") {
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

  // Ensure base memory tool uses memory_apply_patch instead of legacy memory
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });

    const currentTools = agent.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // Determine which memory tool we want based on toolset
    const desiredMemoryTool = toolsetName === "default" ? "memory" : "memory_apply_patch";
    const otherMemoryTool = desiredMemoryTool === "memory" ? "memory_apply_patch" : "memory";

    // Ensure desired memory tool is attached
    let desiredId = mapByName.get(desiredMemoryTool);
    if (!desiredId) {
      const resp = await client.tools.list({ name: desiredMemoryTool });
      desiredId = resp.items[0]?.id;
    }
    if (!desiredId) {
      console.warn(
        `Could not find tool id for ${desiredMemoryTool}. Keeping existing memory tool if present.`,
      );
    }

    const otherId = mapByName.get(otherMemoryTool);

    // Build new tool_ids: add desired memory tool, remove the other if present
    const currentIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const newIds = new Set(currentIds);

    // Only swap if we have a valid desired tool id; otherwise keep existing
    if (desiredId) {
      if (otherId) newIds.delete(otherId);
      newIds.add(desiredId);
    }

    // Update tool_rules: rewrite any rules targeting the other tool to the desired tool
    const updatedRules = (agent.tool_rules || []).map((r) =>
      r.tool_name === otherMemoryTool ? { ...r, tool_name: desiredMemoryTool } : r,
    );

    await client.agents.update(agentId, {
      tool_ids: Array.from(newIds),
      tool_rules: updatedRules,
    });
  } catch (err) {
    console.warn(
      `Warning: Failed to enforce memory_apply_patch base tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

  // Upsert the new toolset (stored in the tool registry) to server
  const client = await getClient();
  await upsertToolsToServer(client);

  // Remove old Letta tools and add new ones
  await unlinkToolsFromAgent(agentId);
  await linkToolsToAgent(agentId);

  // Ensure base memory tool uses memory_apply_patch instead of legacy memory
  try {
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // Determine which memory tool we want based on provider
    const desiredMemoryTool = isOpenAIModel(resolvedModel)
      ? "memory_apply_patch"
      : (await import("./manager")).isGeminiModel(resolvedModel)
        ? "memory_apply_patch"
        : "memory";
    const otherMemoryTool = desiredMemoryTool === "memory" ? "memory_apply_patch" : "memory";

    // Ensure desired memory tool attached
    let desiredId = mapByName.get(desiredMemoryTool);
    if (!desiredId) {
      const resp = await client.tools.list({ name: desiredMemoryTool });
      desiredId = resp.items[0]?.id;
    }
    if (!desiredId) {
      console.warn(
        `Could not find tool id for ${desiredMemoryTool}. Keeping existing memory tool if present.`,
      );
    }

    const otherId = mapByName.get(otherMemoryTool);

    const currentIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const newIds = new Set(currentIds);
    if (desiredId) {
      if (otherId) newIds.delete(otherId);
      newIds.add(desiredId);
    }

    const updatedRules = (agentWithTools.tool_rules || []).map((r) =>
      r.tool_name === otherMemoryTool ? { ...r, tool_name: desiredMemoryTool } : r,
    );

    await client.agents.update(agentId, {
      tool_ids: Array.from(newIds),
      tool_rules: updatedRules,
    });
  } catch (err) {
    console.warn(
      `Warning: Failed to enforce memory_apply_patch base tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { isGeminiModel } = await import("./manager");
  const toolsetName = isOpenAIModel(resolvedModel)
    ? "codex"
    : isGeminiModel(resolvedModel)
      ? "gemini"
      : "default";
  return toolsetName;
}
