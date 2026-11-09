import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  getSubagentHistory,
  type SubagentHistoryEntry,
} from "@/agent/subagent-state.js";
import { type Backend, getBackend } from "@/backend";
import { INTERRUPTED_BY_USER } from "@/constants";
import { subagentScopeMatches } from "@/utils/subagent-scope";
import { parseExternalCodingAgentId } from "./external-coding-agent.js";

export const LISTED_AGENT_STATUSES = [
  "running",
  "completed",
  "failed",
  "stopped",
] as const;

export type ListedAgentStatus = (typeof LISTED_AGENT_STATUSES)[number];

export interface ListedAgent {
  name: string;
  type: string;
  agent_id: string | null;
  conversation_id?: string;
  task_id?: string;
  status: ListedAgentStatus;
  started_at: string;
  last_activity_at: string;
  computer?: string;
  error?: string;
}

/** One row of `letta agents list`, trimmed to what a model needs. */
export interface ListedBackendAgent {
  agent_id: string;
  name: string;
  model?: string;
  created_at?: string;
  last_run_at?: string;
}

export interface ListSubagentsResult {
  agents: ListedAgent[];
}

export interface ListAllAgentsResult {
  agents: ListedBackendAgent[];
  truncated?: boolean;
}

export type ListAgentsResult = ListSubagentsResult | ListAllAgentsResult;

interface ListAgentsArgs {
  subagents_only?: boolean;
  status?: ListedAgentStatus[];
}

interface ListAgentsDeps {
  history?: () => SubagentHistoryEntry[];
  scope?: () => { agentId: string; conversationId: string } | null;
  backend?: Pick<Backend, "listAgents">;
}

/** Rows returned when subagents_only is false; one extra detects truncation. */
const ALL_AGENTS_LIMIT = 50;

function currentScope(): { agentId: string; conversationId: string } | null {
  try {
    return {
      agentId: getCurrentAgentId(),
      conversationId: getConversationId() ?? "default",
    };
  } catch {
    return null;
  }
}

function statusOf(entry: SubagentHistoryEntry): ListedAgentStatus {
  const { agent } = entry;
  if (agent.status === "pending" || agent.status === "running") {
    return "running";
  }
  if (agent.status === "completed") return "completed";
  return agent.stoppedByCaller || agent.error === INTERRUPTED_BY_USER
    ? "stopped"
    : "failed";
}

/**
 * Rows for one child share its address; a follow-up send adds a row. A child
 * running in an ephemeral conversation has no agent, so its conversation ID
 * alone is the address.
 */
function addressKey(entry: SubagentHistoryEntry): string {
  const { agent } = entry;
  if (agent.agentId) {
    return `${agent.agentId}\u0000${agent.conversationId ?? ""}`;
  }
  if (agent.conversationId && agent.conversationId !== "default") {
    return `conv:${agent.conversationId}`;
  }
  return `row:${agent.id}`;
}

function toListedAgent(
  first: SubagentHistoryEntry,
  latest: SubagentHistoryEntry,
): ListedAgent {
  const agent = latest.agent;
  // Agentless (ephemeral-conversation) children have no agent ID.
  const agentId = agent.agentId || first.agent.agentId || null;
  const external = parseExternalCodingAgentId(agentId ?? undefined);
  const status = statusOf(latest);
  const conversationId = external
    ? undefined
    : (agent.conversationId ?? first.agent.conversationId ?? undefined);
  const taskId = agent.taskId ?? first.agent.taskId;
  const computer =
    external?.computer ?? agent.computer ?? first.agent.computer ?? undefined;
  return {
    name: first.agent.description,
    type: first.agent.type,
    agent_id: agentId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    status,
    started_at: new Date(first.agent.startTime).toISOString(),
    last_activity_at: new Date(latest.lastActivityMs).toISOString(),
    ...(computer ? { computer } : {}),
    ...(status === "failed" && agent.error ? { error: agent.error } : {}),
  };
}

function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  const maybePage = page as
    | { getPaginatedItems?: () => T[]; items?: T[] }
    | undefined;
  if (typeof maybePage?.getPaginatedItems === "function") {
    return maybePage.getPaginatedItems();
  }
  return Array.isArray(maybePage?.items) ? maybePage.items : [];
}

/** This conversation's Agent launches, newest first, keyed by address. */
export function listSessionSubagents(
  scope: { agentId: string; conversationId: string } | null,
  history: SubagentHistoryEntry[] = getSubagentHistory(),
): ListedAgent[] {
  const groups = new Map<
    string,
    { first: SubagentHistoryEntry; latest: SubagentHistoryEntry }
  >();
  for (const entry of history) {
    const { agent } = entry;
    // Memory workers maintain this agent's own memory; they are not peers.
    if (agent.type.toLowerCase() === "memory") continue;
    if (
      scope &&
      !subagentScopeMatches(agent.parentAgentId, agent.parentConversationId, {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
      })
    ) {
      continue;
    }
    const key = addressKey(entry);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { first: entry, latest: entry });
    } else if (entry.agent.startTime >= group.latest.agent.startTime) {
      group.latest = entry;
    }
  }
  return Array.from(groups.values())
    .map(({ first, latest }) => toListedAgent(first, latest))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

const VALID_STATUSES = LISTED_AGENT_STATUSES.join(", ");

/**
 * The statuses to keep, or null for all. An empty array is rejected rather
 * than read as "none" or "all": omit `status` to list every agent.
 */
function parseStatusFilter(status: unknown): Set<ListedAgentStatus> | null {
  if (status === undefined) return null;
  if (!Array.isArray(status)) {
    throw new Error(`status must be an array of: ${VALID_STATUSES}`);
  }
  if (status.length === 0) {
    throw new Error(
      `status must list at least one of: ${VALID_STATUSES}. Omit it to list all.`,
    );
  }
  const invalid = status.filter(
    (s) => !(LISTED_AGENT_STATUSES as readonly unknown[]).includes(s),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown status ${invalid.map((s) => JSON.stringify(s)).join(", ")}; valid values: ${VALID_STATUSES}`,
    );
  }
  return new Set(status as ListedAgentStatus[]);
}

function toListedBackendAgent(agent: AgentState): ListedBackendAgent {
  const raw = agent as AgentState & {
    created_at?: string | null;
    last_run_completion?: string | null;
  };
  return {
    agent_id: agent.id,
    name: agent.name,
    ...(agent.model ? { model: agent.model } : {}),
    ...(raw.created_at ? { created_at: raw.created_at } : {}),
    ...(raw.last_run_completion
      ? { last_run_at: raw.last_run_completion }
      : {}),
  };
}

export async function list_agents(
  args?: { subagents_only?: true; status?: ListedAgentStatus[] },
  deps?: ListAgentsDeps,
): Promise<ListSubagentsResult>;
export async function list_agents(
  args: { subagents_only: false },
  deps?: ListAgentsDeps,
): Promise<ListAllAgentsResult>;
export async function list_agents(
  args?: ListAgentsArgs,
  deps?: ListAgentsDeps,
): Promise<ListAgentsResult>;
export async function list_agents(
  args: ListAgentsArgs = {},
  deps: ListAgentsDeps = {},
): Promise<ListAgentsResult> {
  const subagentsOnly = args.subagents_only ?? true;
  if (typeof subagentsOnly !== "boolean") {
    throw new Error("subagents_only must be a boolean");
  }
  const statusFilter = parseStatusFilter(args.status);
  if (subagentsOnly) {
    const scope = (deps.scope ?? currentScope)();
    // Filter after merging by address, so each row's latest status decides.
    const agents = listSessionSubagents(
      scope,
      (deps.history ?? getSubagentHistory)(),
    );
    return {
      agents: statusFilter
        ? agents.filter((agent) => statusFilter.has(agent.status))
        : agents,
    };
  }
  if (statusFilter) {
    // All-agents rows carry no run status to filter on.
    throw new Error(
      "status applies only to subagents_only: true; all-agents rows have no status",
    );
  }

  // Same call as `letta agents list`, with a larger page.
  const backend = deps.backend ?? getBackend();
  const listed = pageItems<AgentState>(
    await backend.listAgents({ limit: ALL_AGENTS_LIMIT + 1 }),
  );
  const agents = listed.slice(0, ALL_AGENTS_LIMIT).map(toListedBackendAgent);
  return listed.length > ALL_AGENTS_LIMIT
    ? { agents, truncated: true }
    : { agents };
}
