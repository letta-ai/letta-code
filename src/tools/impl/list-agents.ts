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

export type ListedAgentStatus = "running" | "completed" | "failed" | "stopped";

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

/** Rows for one child share its address; a follow-up send adds a row. */
function addressKey(entry: SubagentHistoryEntry): string {
  const { agent } = entry;
  if (!agent.agentId) return `row:${agent.id}`;
  return `${agent.agentId}\u0000${agent.conversationId ?? ""}`;
}

function toListedAgent(
  first: SubagentHistoryEntry,
  latest: SubagentHistoryEntry,
): ListedAgent {
  const agent = latest.agent;
  const agentId = agent.agentId ?? first.agent.agentId ?? null;
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
  args?: { subagents_only?: true },
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
  if (subagentsOnly) {
    const scope = (deps.scope ?? currentScope)();
    return {
      agents: listSessionSubagents(
        scope,
        (deps.history ?? getSubagentHistory)(),
      ),
    };
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
