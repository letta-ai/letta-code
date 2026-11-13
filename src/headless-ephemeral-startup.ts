import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createEphemeralConversation,
  createLocalEphemeralConversation,
  projectConversationState,
} from "@/agent/ephemeral-conversation";
import {
  type Backend,
  configureEphemeralLocalBackend,
  isLocalBackendEnabled,
} from "@/backend";
import { clearPersistedClientToolRules } from "@/tools/toolset";
import { debugLog, debugWarn } from "@/utils/debug";

export function prepareHeadlessEphemeralBackend(enabled: boolean): void {
  if (enabled && isLocalBackendEnabled()) {
    configureEphemeralLocalBackend();
  }
}

export async function createHeadlessEphemeralConversation(params: {
  backendMode: string;
  personality: string | null | undefined;
  model: string | undefined;
  systemPromptPreset: string | undefined;
  systemPromptCustom: string | undefined;
}): Promise<{
  agent: AgentState;
  conversationId: string;
  parentAgentId: string | null;
}> {
  if (params.personality) {
    throw new Error(
      "--ephemeral cannot be used with --personality because it has no memory blocks",
    );
  }
  const options = {
    model: params.model,
    systemPromptPreset: params.systemPromptPreset,
    systemPromptCustom: params.systemPromptCustom,
    memoryPromptMode: "standard" as const,
  };
  return params.backendMode === "local"
    ? {
        ...(await createLocalEphemeralConversation(options)),
        parentAgentId: null,
      }
    : createEphemeralConversation(options);
}

/**
 * Warm the secrets cache for a headless session. An agent-backed session uses
 * its own vault. A detached subagent conversation has no vault, so it reads
 * its parent agent's (the vault the parent's own tools would use); other
 * detached sessions get none.
 */
export function initHeadlessSecrets(
  agentId: string,
  detached: boolean,
  parentAgentId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const vaultAgentId = !detached
    ? agentId
    : env.LETTA_CODE_AGENT_ROLE === "subagent"
      ? parentAgentId
      : null;
  if (!vaultAgentId) return Promise.resolve();
  return import("@/utils/secrets-store").then(async (secrets) => {
    if (vaultAgentId !== agentId) {
      secrets.linkSecretsVault(agentId, vaultAgentId);
      (await import("@/utils/variables-store")).linkVariablesVault(
        agentId,
        vaultAgentId,
      );
    }
    return secrets.initSecretsFromServer(vaultAgentId);
  });
}

/**
 * The ambient agent (`LETTA_AGENT_ID`/`AGENT_ID`) a routed headless launch
 * should target when no explicit target was given. An `--ephemeral` session
 * has no agent, so an inherited AGENT_ID (set in Cloud sandboxes and passed
 * down to subagents) must not become `--agent` there.
 */
export function resolveAmbientAgentId(
  params: { routed: unknown; ephemeral: unknown; explicitTarget: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!params.routed || params.ephemeral || params.explicitTarget) {
    return undefined;
  }
  return (env.LETTA_AGENT_ID || env.AGENT_ID || "").trim() || undefined;
}

export function clearHeadlessClientToolRules(agent: AgentState): void {
  void clearPersistedClientToolRules(agent.id, agent)
    .then((cleanup) => {
      if (cleanup) {
        const count = cleanup.removedToolNames.length;
        const names = cleanup.removedToolNames.join(", ");
        debugLog(
          "headless startup",
          `Cleared ${count} persisted client tool rule${count === 1 ? "" : "s"} for ${agent.id}${count > 0 ? `: ${names}` : ""}`,
        );
        return;
      }
      debugLog(
        "headless startup",
        `No persisted client tool rules to clear for ${agent.id}`,
      );
    })
    .catch((error) => {
      debugWarn(
        "headless startup",
        `Failed to clear persisted client tool rules for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/** Return the existing parent without treating it as the history owner. */
export async function retrieveHeadlessConversation(
  backend: Pick<Backend, "retrieveAgent" | "retrieveConversation">,
  conversationId: string,
): Promise<{
  agent: AgentState;
  detached: boolean;
  parentAgentId: string | null;
}> {
  const conversation = await backend.retrieveConversation(conversationId);
  const detached = conversation.agent_id === null;
  const parentId = Reflect.get(conversation, "parent_agent_id");
  return {
    agent: detached
      ? projectConversationState(conversation)
      : await backend.retrieveAgent(conversation.agent_id, {
          include: ["agent.tools", "agent.tags"],
        }),
    detached,
    parentAgentId: detached && typeof parentId === "string" ? parentId : null,
  };
}
