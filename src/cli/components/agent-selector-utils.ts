import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelDisplayName } from "@/agent/model";

export interface AgentSelectorListAgent {
  id: string;
  name?: string | null;
  description?: string | null;
  last_run_completion?: string | null;
  creator?: AgentSelectorAgentCreator | null;
  blocks?: AgentState["blocks"];
  model?: AgentState["model"];
  llm_config?: AgentState["llm_config"];
}

export interface AgentSelectorAgentCreator {
  id: string;
  name?: string | null;
  email?: string | null;
  image_url?: string | null;
}

export interface AgentSelectorTabDefinition {
  id: AgentSelectorTabId;
  label: string;
}

export interface AgentSelectorVisibleTabsOptions {
  showNewTab: boolean;
  hasLocalAgents: boolean;
  hasCloudAuth: boolean | null;
}

export type AgentSelectorTabId =
  | "pinned"
  | "local"
  | "cloud"
  | "shared"
  | "new";

export const AGENT_SELECTOR_TABS: AgentSelectorTabDefinition[] = [
  { id: "pinned", label: "Pinned" },
  { id: "cloud", label: "Cloud" },
  { id: "shared", label: "Shared" },
  { id: "local", label: "Local" },
  { id: "new", label: "New" },
];

export const AGENT_SELECTOR_TAB_DESCRIPTIONS: Record<
  AgentSelectorTabId,
  string
> = {
  pinned: "Save agents for easy access with /pin or Desktop favorites",
  local: "Local agents from this device",
  cloud: "Agents hosted in Letta Cloud",
  shared: "Agents shared with you in Letta Cloud",
  new: "Create a brand new agent",
};

export const AGENT_SELECTOR_TAB_EMPTY_STATES: Record<
  AgentSelectorTabId,
  string
> = {
  pinned: "No pinned or favorite agents, use /pin to save",
  local: "No local agents found",
  cloud: "No agents found",
  shared: "No shared agents found",
  new: "",
};

export function getVisibleAgentSelectorTabs({
  showNewTab,
  hasLocalAgents,
  hasCloudAuth,
}: AgentSelectorVisibleTabsOptions): AgentSelectorTabDefinition[] {
  return AGENT_SELECTOR_TABS.filter(
    (tab) =>
      (showNewTab || tab.id !== "new") &&
      (tab.id !== "shared" || hasCloudAuth === true) &&
      (tab.id !== "local" || hasLocalAgents),
  );
}

export function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60)
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return `${diffWeeks} week${diffWeeks === 1 ? "" : "s"} ago`;
}

export function truncateAgentId(id: string, availableWidth: number): string {
  if (id.length <= availableWidth) return id;
  if (availableWidth < 15) return id.slice(0, availableWidth);
  const prefixLen = Math.floor((availableWidth - 3) / 2);
  const suffixLen = availableWidth - 3 - prefixLen;
  return `${id.slice(0, prefixLen)}...${id.slice(-suffixLen)}`;
}

export function formatAgentMemoryBlockCount(
  blockCount: number | null | undefined,
): string | null {
  if (blockCount === null || blockCount === undefined || blockCount <= 0) {
    return null;
  }
  return `${blockCount} memory block${blockCount === 1 ? "" : "s"}`;
}

export function formatAgentModel(agent: AgentSelectorListAgent): string {
  let handle: string | null = null;
  if (agent.model) {
    handle = agent.model;
  } else if (agent.llm_config?.model) {
    const provider = agent.llm_config.model_endpoint_type || "unknown";
    handle = `${provider}/${agent.llm_config.model}`;
  }

  if (handle) {
    const displayName = getModelDisplayName(handle);
    if (displayName) return displayName;
    return handle;
  }
  return "unknown";
}
