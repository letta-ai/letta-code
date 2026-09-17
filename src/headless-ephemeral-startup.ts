import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createEphemeralConversation,
  createLocalEphemeralConversation,
  projectResumedEphemeralConversation,
} from "@/agent/ephemeral-conversation";
import {
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

export function getHeadlessEphemeralIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { name?: string; isSubagent: boolean; parentAgentId?: string } {
  const parentAgentId = env.LETTA_PARENT_AGENT_ID?.trim();
  return {
    name: env.LETTA_SUBAGENT_NAME,
    isSubagent: env.LETTA_CODE_AGENT_ROLE === "subagent",
    // Resource lineage is independent of the child's tool restrictions.
    // Nested ephemeral execution IDs (conv-*) are not agent parents.
    ...(parentAgentId &&
    /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      parentAgentId,
    )
      ? { parentAgentId }
      : {}),
  };
}

export function resumeHeadlessEphemeralConversation(
  conversation: Parameters<typeof projectResumedEphemeralConversation>[0] & {
    parent_agent_id?: string | null;
  },
  bidirectional: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { agent: AgentState; parentAgentId?: string } {
  if (bidirectional) {
    throw new Error(
      "Ephemeral conversations do not support bidirectional headless input",
    );
  }
  const agent = projectResumedEphemeralConversation(conversation);
  // Persisted lineage is authoritative, including a deliberately absent parent.
  if (conversation.parent_agent_id) {
    env.LETTA_PARENT_AGENT_ID = conversation.parent_agent_id;
  } else {
    delete env.LETTA_PARENT_AGENT_ID;
  }
  return {
    agent,
    parentAgentId: getHeadlessEphemeralIdentity(env).parentAgentId,
  };
}

export async function createHeadlessEphemeralConversation(params: {
  backendMode: string;
  personality: string | null | undefined;
  model: string | undefined;
  systemPromptPreset: string | undefined;
  systemPromptCustom: string | undefined;
}): Promise<{ agent: AgentState; conversationId: string }> {
  if (params.personality) {
    throw new Error(
      "--ephemeral cannot be used with --personality because it has no memory blocks",
    );
  }
  const options = {
    ...getHeadlessEphemeralIdentity(),
    model: params.model,
    systemPromptPreset: params.systemPromptPreset,
    systemPromptCustom: params.systemPromptCustom,
    memoryPromptMode: "standard" as const,
  };
  return params.backendMode === "local"
    ? createLocalEphemeralConversation(options)
    : createEphemeralConversation(options);
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
