/**
 * Environment routing helpers for the Task (Agent) tool: validation,
 * target resolution, and prompt reminders for subagent turns dispatched to a
 * connected environment instead of a local child process.
 */

import { getCurrentAgentId } from "@/agent/context";
import {
  buildDeploySystemReminder,
  buildForkSystemReminder,
  shouldPrependDeploySystemReminder,
} from "@/agent/subagents/manager";
import { type Backend, getBackend } from "@/backend";

/**
 * Validate an Agent-tool request that names a remote environment. Returns an
 * error string for the model, or null when the request shape is routable.
 */
export function validateTaskEnvironmentRequest(params: {
  fork: boolean;
  isDeployingExisting: boolean;
  localBackend: boolean;
  agentId?: string;
  conversationId?: string;
}): string | null {
  if (params.localBackend) {
    return "Error: The environment parameter requires the API backend. Connected environments are unavailable on the local backend.";
  }
  if (!params.fork && !params.isDeployingExisting) {
    return `Error: The environment parameter requires an existing conversation to route. Use subagent_type "fork", or pass agent_id/conversation_id to deploy an existing agent.`;
  }
  if (params.conversationId === "default" && !params.agentId) {
    return 'Error: conversation_id "default" needs agent_id to identify the agent when routing to an environment.';
  }
  return null;
}

/**
 * Resolve the agent + conversation a remote environment will run. Deploying
 * with only agent_id creates a fresh conversation (parity with the local
 * `--new` behavior); conversation_id-only lookups derive the owning agent.
 */
export async function resolveRemoteTaskTarget(params: {
  backend: Backend;
  agentId?: string;
  conversationId?: string;
}): Promise<{ agentId: string; conversationId: string }> {
  if (params.conversationId && params.conversationId !== "default") {
    if (params.agentId) {
      return {
        agentId: params.agentId,
        conversationId: params.conversationId,
      };
    }
    const conversation = await params.backend.retrieveConversation(
      params.conversationId,
    );
    return {
      agentId: conversation.agent_id,
      conversationId: params.conversationId,
    };
  }
  if (!params.agentId) {
    throw new Error(
      "agent_id or conversation_id is required to route a task to an environment",
    );
  }
  if (params.conversationId === "default") {
    return { agentId: params.agentId, conversationId: "default" };
  }
  const conversation = await params.backend.createConversation({
    agent_id: params.agentId,
  });
  return { agentId: params.agentId, conversationId: conversation.id };
}

/**
 * Prepend the same system reminder the local spawn path adds inside
 * spawnSubagent. The remote path bypasses spawnSubagent, so the reminder is
 * applied here before dispatch.
 */
export async function prependRemoteTaskReminder(params: {
  prompt: string;
  subagentType: string;
  fork: boolean;
  deployedAgentId?: string;
}): Promise<string> {
  if (params.fork) {
    return buildForkSystemReminder(params.subagentType, "api") + params.prompt;
  }
  try {
    const parentAgentId = getCurrentAgentId();
    if (
      !shouldPrependDeploySystemReminder(params.deployedAgentId, parentAgentId)
    ) {
      return params.prompt;
    }
    const parentAgent = await getBackend().retrieveAgent(parentAgentId);
    return (
      buildDeploySystemReminder(parentAgent.name ?? "", parentAgentId) +
      params.prompt
    );
  } catch {
    // Parent context unavailable — dispatch without the reminder.
    return params.prompt;
  }
}
