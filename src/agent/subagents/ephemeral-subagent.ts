import { getCurrentAgentId } from "@/agent/context";
import type { BackendMode } from "@/backend";
import { SUBAGENT_NAME_ENV } from "@/utils/subagent-launch-marker";
import { resolveCreatedAgentName } from "./names";

export const EPHEMERAL_SUBAGENTS_ENV = "LETTA_CODE_EPHEMERAL_SUBAGENTS";

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

export function resolveDetachedSubagentEnvAgentId(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!sessionId.startsWith("conv-")) return undefined;
  if (env.LETTA_CODE_AGENT_ROLE !== "subagent") return undefined;
  return env.LETTA_PARENT_AGENT_ID?.trim() || undefined;
}

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

export function getEffectiveAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveEffectiveAgentId(getCurrentAgentId(), env);
}

interface DetachedConversationLookup {
  retrieveConversation(conversationId: string): Promise<object>;
}

export async function lookupDetachedConversationParent(
  conversationId: string,
  backend: DetachedConversationLookup,
): Promise<string | undefined> {
  const conversation = await backend.retrieveConversation(conversationId);
  if (
    Reflect.get(conversation, "agent_id") !== null ||
    Reflect.get(conversation, "is_subagent") !== true
  ) {
    return undefined;
  }
  const parentId = Reflect.get(conversation, "parent_agent_id");
  return typeof parentId === "string" && parentId ? parentId : undefined;
}
