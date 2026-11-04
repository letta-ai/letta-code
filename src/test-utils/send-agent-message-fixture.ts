import type { TrackChildSendInput } from "@/agent/subagents/child-send-tracking";
import type { AgentRetrieveOptions, Backend } from "@/backend";
import type { EnqueueConversationInput } from "@/backend/api/conversation-enqueue";

/** Shared SendAgentMessage tool fixture: a Cloud backend and recording deps. */
export const TARGET_CONV = "conv-33333333-3333-4333-8333-333333333333";

export function sendAgentMessageFixture(
  targetTags: readonly string[] = [],
  /** Agent the server reports in the enqueue receipt; older servers omit it. */
  serverAgentId?: string,
) {
  const submissions: EnqueueConversationInput[] = [];
  const created: unknown[] = [];
  const tracked: TrackChildSendInput[] = [];
  const backend = {
    capabilities: { environmentRouting: true },
    retrieveAgent: async (id: string, options?: AgentRetrieveOptions) => ({
      id,
      name: "Hayt",
      // Cloud only returns tags when explicitly included.
      tags: options?.include?.includes("agent.tags") ? targetTags : [],
    }),
    retrieveConversation: async (id: string) => ({
      id,
      agent_id: "agent-target",
    }),
    createConversation: async (input: unknown) => {
      created.push(input);
      return { id: "conv-new" };
    },
  } as unknown as Backend;
  const enqueue = async (input: EnqueueConversationInput) => {
    submissions.push(input);
    return {
      status: "queued" as const,
      agent_id: serverAgentId ?? input.agentId ?? null,
      conversation_id: input.conversationId,
      client_message_id: input.clientMessageId,
      workflow_id: "wf-1",
      super_run_id: "sr-1",
    };
  };
  const trackChildSend = (input: TrackChildSendInput) => {
    tracked.push(input);
    return "subagent-tracked";
  };
  // Keep worker resumes off the real vault and MCP inventory.
  const workerEnv = {
    resolveSecretEnv: async () => ({}),
    resolveMcpReminder: async () => undefined,
  };
  return {
    backend,
    enqueue,
    trackChildSend,
    workerEnv,
    submissions,
    created,
    tracked,
  };
}

export const caller = {
  agentId: "agent-caller",
  conversationId: "conv-caller",
  actingUserId: "user-caller",
};
export const message = {
  conversation_id: TARGET_CONV,
  message: "Please check the tests.",
};
