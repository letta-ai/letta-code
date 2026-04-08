import type {
  AgentState,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import { DEFAULT_SUMMARIZATION_MODEL } from "../constants";

export const DEFAULT_ATTACHED_BASE_TOOLS = [
  "web_search",
  "fetch_webpage",
] as const;

type AgentStateReconcileClient = {
  agents: {
    update: (agentID: string, body: AgentUpdateParams) => Promise<AgentState>;
  };
  tools: {
    list: (query?: { name?: string | null; limit?: number | null }) => Promise<{
      items: Tool[];
    }>;
  };
};

export interface ReconcileAgentStateResult {
  updated: boolean;
  agent: AgentState;
  appliedTweaks: string[];
  skippedTweaks: string[];
}

function areToolSetsEqual(
  currentToolIds: string[],
  desiredToolIds: string[],
): boolean {
  if (currentToolIds.length !== desiredToolIds.length) {
    return false;
  }

  const currentSet = new Set(currentToolIds);
  for (const toolId of desiredToolIds) {
    if (!currentSet.has(toolId)) {
      return false;
    }
  }
  return true;
}

function getToolName(tool: Tool): string {
  if (typeof tool.name !== "string") {
    return "";
  }
  return tool.name.trim();
}

function getAttachedToolIdsByName(agent: AgentState): Map<string, string> {
  const toolIdsByName = new Map<string, string>();
  for (const tool of agent.tools ?? []) {
    const name = getToolName(tool);
    if (!name || !tool.id || toolIdsByName.has(name)) {
      continue;
    }
    toolIdsByName.set(name, tool.id);
  }
  return toolIdsByName;
}

async function resolveToolIdByName(
  client: AgentStateReconcileClient,
  toolName: string,
): Promise<string | null> {
  const response = await client.tools.list({
    name: toolName,
    limit: 10,
  });

  if (!Array.isArray(response.items) || response.items.length === 0) {
    return null;
  }

  const exactMatch = response.items.find(
    (tool) => getToolName(tool) === toolName,
  );
  const match = exactMatch ?? response.items[0];
  return match?.id ?? null;
}

async function resolveDesiredAttachedToolIds(
  client: AgentStateReconcileClient,
  agent: AgentState,
  desiredToolNames: readonly string[],
): Promise<{ toolIds: string[] | null; missingToolNames: string[] }> {
  const attachedByName = getAttachedToolIdsByName(agent);
  const resolvedByName = new Map<string, string>();
  const missingToolNames: string[] = [];

  await Promise.all(
    desiredToolNames.map(async (toolName) => {
      const existingId = attachedByName.get(toolName);
      if (existingId) {
        resolvedByName.set(toolName, existingId);
        return;
      }

      try {
        const resolvedId = await resolveToolIdByName(client, toolName);
        if (resolvedId) {
          resolvedByName.set(toolName, resolvedId);
          return;
        }
      } catch {
        // Treat as missing; caller decides whether to skip this tweak.
      }

      missingToolNames.push(toolName);
    }),
  );

  if (missingToolNames.length > 0) {
    return {
      toolIds: null,
      missingToolNames,
    };
  }

  const toolIds = desiredToolNames
    .map((toolName) => resolvedByName.get(toolName))
    .filter((toolId): toolId is string => Boolean(toolId));

  return {
    toolIds,
    missingToolNames: [],
  };
}

export async function reconcileExistingAgentState(
  client: AgentStateReconcileClient,
  agent: AgentState,
): Promise<ReconcileAgentStateResult> {
  const patch: AgentUpdateParams = {};
  const appliedTweaks: string[] = [];
  const skippedTweaks: string[] = [];

  const configuredCompactionModel =
    typeof agent.compaction_settings?.model === "string"
      ? agent.compaction_settings.model.trim()
      : "";

  if (!configuredCompactionModel) {
    patch.compaction_settings = {
      ...(agent.compaction_settings ?? {}),
      model: DEFAULT_SUMMARIZATION_MODEL,
    };
    appliedTweaks.push("set_compaction_model");
  }

  const desiredToolNames = DEFAULT_ATTACHED_BASE_TOOLS;
  const desiredTools = await resolveDesiredAttachedToolIds(
    client,
    agent,
    desiredToolNames,
  );

  if (desiredTools.missingToolNames.length > 0 || !desiredTools.toolIds) {
    skippedTweaks.push(
      `sync_attached_tools_missing:${desiredTools.missingToolNames.join(",")}`,
    );
  } else {
    // Only ADD missing base tools — never remove existing tools.
    // The previous logic replaced the entire tool_ids array with just the
    // base tools, which wiped every other tool (MCP, memory, custom, etc.)
    // on every agent startup.
    const currentToolIds = (agent.tools ?? [])
      .map((tool) => tool.id)
      .filter((toolId): toolId is string => Boolean(toolId));

    const currentSet = new Set(currentToolIds);
    const missingBaseToolIds = desiredTools.toolIds.filter(
      (id) => !currentSet.has(id),
    );

    if (missingBaseToolIds.length > 0) {
      patch.tool_ids = [...currentToolIds, ...missingBaseToolIds];
      appliedTweaks.push("sync_attached_tools");
    }
  }

  if (appliedTweaks.length === 0) {
    return {
      updated: false,
      agent,
      appliedTweaks,
      skippedTweaks,
    };
  }

  const updatedAgent = await client.agents.update(agent.id, patch);
  return {
    updated: true,
    agent: updatedAgent,
    appliedTweaks,
    skippedTweaks,
  };
}
