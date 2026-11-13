/**
 * Fresh preset subagents on Cloud run in an ephemeral conversation instead of
 * a new hidden agent per call. The conversation has no agent of its own: it
 * carries the preset's system prompt and model, links to the parent agent
 * (which supplies MCP servers, secrets and permissions), and its toolset is
 * the client-side preset allowlist (`--tools`).
 */
import { getCurrentAgentId } from "@/agent/context";
import type { BackendMode } from "@/backend";
import { SUBAGENT_NAME_ENV } from "@/utils/subagent-launch-marker";
import { resolveCreatedAgentName } from "./names";

/** Set to "0" or "false" to fall back to creating a hidden agent per call. */
export const EPHEMERAL_SUBAGENTS_ENV = "LETTA_CODE_EPHEMERAL_SUBAGENTS";

/**
 * Parent side: whether a launch should use `--ephemeral` in place of
 * `--new-agent`. Deploying an agent or conversation (`agent_id`,
 * `conversation_id`, `fork_context`) keeps its existing path, as do the local
 * backend and computer-routed launches (remote turns need a real agent).
 */
export function shouldRunSubagentEphemerally(params: {
  backendMode?: BackendMode;
  existingAgentId?: string;
  existingConversationId?: string;
  environment?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const optOut = (params.env ?? process.env)[EPHEMERAL_SUBAGENTS_ENV]
    ?.trim()
    .toLowerCase();
  return (
    params.backendMode === "api" &&
    !params.existingAgentId &&
    !params.existingConversationId &&
    !params.environment &&
    optOut !== "0" &&
    optOut !== "false"
  );
}

export interface EphemeralSubagentLink {
  parent_agent_id: string;
  is_subagent: true;
  name: string;
}

/**
 * Child side: how the ephemeral conversation links to its parent. Cloud
 * records `parent_agent_id` (authorized against the caller's organization)
 * and derives the parent conversation from the sandbox key's binding, so
 * user-scoped private resources resolve through the same conversation chain
 * as the parent's turn.
 */
export function resolveEphemeralSubagentLink(
  env: NodeJS.ProcessEnv = process.env,
): EphemeralSubagentLink | null {
  if (env.LETTA_CODE_AGENT_ROLE !== "subagent") return null;
  const parentAgentId = env.LETTA_PARENT_AGENT_ID?.trim();
  if (!parentAgentId) return null;
  return {
    parent_agent_id: parentAgentId,
    is_subagent: true,
    name: resolveCreatedAgentName(
      undefined,
      true,
      env[SUBAGENT_NAME_ENV]?.trim() || undefined,
    ),
  };
}

/**
 * The agent ID a detached subagent session exports as `AGENT_ID` /
 * `LETTA_AGENT_ID` to its tools: the parent agent, since the session's own ID
 * is a conversation ID. Undefined for any other session.
 */
export function resolveDetachedSubagentEnvAgentId(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!sessionId.startsWith("conv-")) return undefined;
  if (env.LETTA_CODE_AGENT_ROLE !== "subagent") return undefined;
  return env.LETTA_PARENT_AGENT_ID?.trim() || undefined;
}

/**
 * The real agent behind an agent ID taken from this session's context. A
 * detached subagent's own ID is its conversation ID, so anything that hands
 * an agent identity to a child or the API (nested subagent launches, external
 * coding agents) uses the parent agent instead, matching `AGENT_ID`.
 */
export function resolveEffectiveAgentId(
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string;
export function resolveEffectiveAgentId(
  agentId: string | undefined,
  env?: NodeJS.ProcessEnv,
): string | undefined;
export function resolveEffectiveAgentId(
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!agentId) return agentId;
  return resolveDetachedSubagentEnvAgentId(agentId, env) ?? agentId;
}

/** `getCurrentAgentId()`, resolved to the real agent for detached subagents. */
export function getEffectiveAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveEffectiveAgentId(getCurrentAgentId(), env);
}

interface DetachedConversationLookup {
  retrieveConversation(conversationId: string): Promise<object>;
}

/**
 * The parent agent of a detached subagent conversation, or undefined when the
 * conversation has its own agent or was not created as a subagent. Mirrors
 * the `role:subagent` tag requirement for agent-backed subagents.
 */
export async function lookupDetachedConversationParent(
  conversationId: string,
  backend: DetachedConversationLookup,
): Promise<string | undefined> {
  return (
    await lookupDetachedConversationParentAddress(conversationId, backend)
  )?.agentId;
}

/** Cloud returns the parent agent, but does not expose its conversation ID. */
export async function lookupDetachedConversationParentAddress(
  conversationId: string,
  backend: DetachedConversationLookup,
): Promise<{ agentId: string; conversationId?: string } | undefined> {
  const conversation = await backend.retrieveConversation(conversationId);
  if (
    Reflect.get(conversation, "agent_id") !== null ||
    Reflect.get(conversation, "is_subagent") !== true
  ) {
    return undefined;
  }
  const parentId = Reflect.get(conversation, "parent_agent_id");
  if (typeof parentId !== "string" || !parentId) return undefined;
  return { agentId: parentId };
}
