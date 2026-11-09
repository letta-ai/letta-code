import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  getSubagentHistory,
  type SubagentHistoryEntry,
} from "@/agent/subagent-state.js";
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

export interface ListSubagentsResult {
  agents: ListedAgent[];
}

interface ListSubagentsArgs {
  status?: ListedAgentStatus[];
}

interface ListSubagentsDeps {
  history?: () => SubagentHistoryEntry[];
  scope?: () => { agentId: string; conversationId: string } | null;
}

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
 * The statuses to keep; omitted means running only. An empty array is
 * rejected rather than read as "none" or "all".
 */
function parseStatusFilter(status: unknown): Set<ListedAgentStatus> {
  if (status === undefined) return new Set(["running"]);
  if (!Array.isArray(status)) {
    throw new Error(`status must be an array of: ${VALID_STATUSES}`);
  }
  if (status.length === 0) {
    throw new Error(
      `status must list at least one of: ${VALID_STATUSES}. Omit it to list running agents.`,
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

export async function list_subagents(
  args: ListSubagentsArgs = {},
  deps: ListSubagentsDeps = {},
): Promise<ListSubagentsResult> {
  const statusFilter = parseStatusFilter(args.status);
  const scope = (deps.scope ?? currentScope)();
  // Filter after merging by address, so each row's latest status decides.
  const agents = listSessionSubagents(
    scope,
    (deps.history ?? getSubagentHistory)(),
  );
  return { agents: agents.filter((agent) => statusFilter.has(agent.status)) };
}
