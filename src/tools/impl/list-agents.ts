import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
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

export interface ListedConversation {
  conversation_id: string;
  summary?: string;
  last_message_at?: string;
}

export interface ListAgentsResult {
  agents: ListedAgent[];
  conversations?: ListedConversation[];
}

interface ListAgentsArgs {
  scope?: "subagents" | "all";
}

interface ListAgentsDeps {
  history?: () => SubagentHistoryEntry[];
  scope?: () => { agentId: string; conversationId: string } | null;
  backend?: Pick<Backend, "listConversations">;
}

const CONVERSATION_LIMIT = 20;

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

export async function list_agents(
  args: ListAgentsArgs = {},
  deps: ListAgentsDeps = {},
): Promise<ListAgentsResult> {
  const scopeName = args.scope ?? "subagents";
  if (scopeName !== "subagents" && scopeName !== "all") {
    throw new Error('scope must be "subagents" or "all"');
  }
  const scope = (deps.scope ?? currentScope)();
  const agents = listSessionSubagents(
    scope,
    (deps.history ?? getSubagentHistory)(),
  );
  if (scopeName === "subagents" || !scope) return { agents };

  const backend = deps.backend ?? getBackend();
  const listed = pageItems<Conversation>(
    await backend.listConversations({
      agent_id: scope.agentId,
      limit: CONVERSATION_LIMIT,
      order: "desc",
      order_by: "last_message_at",
    } as never),
  );
  const childConversations = new Set(
    agents.map((agent) => agent.conversation_id).filter(Boolean),
  );
  const conversations = listed
    .filter(
      (conversation) =>
        conversation.id !== scope.conversationId &&
        !childConversations.has(conversation.id),
    )
    .map((conversation) => {
      const summary = conversation.summary?.trim();
      const lastMessageAt = (
        conversation as Conversation & { last_message_at?: string | null }
      ).last_message_at;
      return {
        conversation_id: conversation.id,
        ...(summary ? { summary } : {}),
        ...(lastMessageAt ? { last_message_at: lastMessageAt } : {}),
      };
    });
  return { agents, conversations };
}
