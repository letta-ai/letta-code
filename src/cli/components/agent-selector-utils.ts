import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { getModelDisplayName } from "@/agent/model";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import type { PinnedAgentData } from "@/cli/helpers/pinned-agent-listing";

export interface AgentSelectorListAgent {
  id: string;
  name?: string | null;
  description?: string | null;
  last_run_completion?: string | null;
  creator?: AgentSelectorAgentCreator | null;
  blocks?: AgentState["blocks"];
  memoryBlockCount?: number;
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

export interface AgentSelectorProps {
  currentAgentId: string;
  sessionCollection?: import("@/cli/app/terminal-session").TerminalSession["listAgentCollection"];
  sessionDelete?: (id: string) => Promise<void>;
  sessionUnpin?: (id: string) => Promise<void>;
  sessionList?: (
    after?: string | null,
    query?: string,
  ) => Promise<{ agents: AgentSelectorListAgent[]; nextCursor: string | null }>;
  onSelect: (agentId: string, backendMode: AgentBackendMode) => void;
  onCancel: () => void;
  onLogin?: () => void;
  onCreateNewAgent?: (name: string, backendMode: AgentBackendMode) => void;
  command?: string;
  title?: string;
  showNewTab?: boolean;
  allowDelete?: boolean;
  allowPinActions?: boolean;
}

export type PickerPin = Omit<PinnedAgentData, "agent"> & {
  agent: AgentSelectorListAgent | null;
};

export type ViewState =
  | { type: "list" }
  | {
      type: "deleteConfirm";
      agent: AgentSelectorListAgent;
      agentId: string;
      isLocal: boolean;
    };

export async function listSessionLocalAgents(
  list: NonNullable<AgentSelectorProps["sessionList"]>,
) {
  const agents: AgentSelectorListAgent[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await list(cursor);
    agents.push(...page.agents);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return agents;
}

export function initialLocalTab(agentId: string, session: boolean) {
  if (session) return isLocalAgentId(agentId);
  try {
    return listLocalAgentsFromDisk().length > 0;
  } catch {
    return false;
  }
}

export async function localPickerAgents(
  sessionCollection: AgentSelectorProps["sessionCollection"],
  sessionList: AgentSelectorProps["sessionList"],
) {
  if (sessionCollection) return (await sessionCollection("local")).agents;
  if (sessionList) return listSessionLocalAgents(sessionList);
  return listLocalAgentsFromDisk();
}
