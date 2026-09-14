import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { actingUserRequestOptions } from "@/agent/acting-user";
import type { Backend } from "@/backend";

/** Optional routing values share the same meaning in CLI and tool sends. */
export function normalizeAgentMessageComputer(
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      "computer must be a computer name, or omitted to use the conversation's current destination.",
    );
  }
  const computer = value.trim();
  if (!computer) return undefined;
  return ["cloud", "cloud-sandbox"].includes(computer.toLowerCase())
    ? "cloud"
    : computer;
}

export function buildAgentSendContent(
  sender: { agentId?: string; conversationId?: string },
  noWait: boolean,
  message: string,
): MessageCreate["content"] {
  const reminder = buildAgentSendReminder(sender, noWait);
  return [
    ...(reminder ? [{ type: "text" as const, text: reminder }] : []),
    { type: "text", text: message },
  ];
}

export function buildAgentSendReminder(
  sender: { agentId?: string; conversationId?: string },
  noWait: boolean,
): string {
  if (!sender.agentId) return "";
  const address = sender.conversationId
    ? `, conversation ${sender.conversationId}`
    : "";
  const instruction = !noWait
    ? "The sender will only see the final message you generate (not tool calls or reasoning). Include your answer in your final response."
    : sender.conversationId
      ? `To reply to agent ${sender.agentId}${address}, use SendAgentMessage if available. Otherwise run letta -p --agent ${sender.agentId} --conversation ${sender.conversationId} --no-wait "your reply". Ordinary assistant output is not forwarded to the sender.`
      : "Ordinary assistant output is not forwarded to the sender. No return conversation was supplied.";
  return `<system-reminder>\nThis message is from agent ${sender.agentId}${address}.\n${instruction}\n</system-reminder>\n\n`;
}

export function validateAddress(
  value: string | undefined,
  kind: "agent" | "conversation",
): string | undefined {
  if (!value) return undefined;
  if (kind === "conversation" && value === "default") return value;
  const prefix = kind === "agent" ? "agent" : "conv";
  if (!new RegExp(`^${prefix}-[a-zA-Z0-9-]+$`).test(value)) {
    throw new Error(`Invalid ${kind} ID: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Shared destination lookup for CLI sends and the SendAgentMessage tool. */
export async function resolveAgentMessageDestination(
  input: {
    agentId?: string;
    conversationId?: string;
    senderAgentId?: string;
    actingUserId?: string;
    /** Calling runtime, independent of optional sender attribution overrides. */
    currentConversation?: { agentId?: string; conversationId?: string };
  },
  backend: Pick<Backend, "retrieveConversation" | "createConversation">,
  signal?: AbortSignal,
): Promise<{ agentId: string; conversationId: string }> {
  let agentId = validateAddress(input.agentId, "agent");
  let conversationId = validateAddress(input.conversationId, "conversation");
  if (!agentId && !conversationId) {
    throw new Error("Choose a destination with agent_id or conversation_id.");
  }
  const options = { signal, ...actingUserRequestOptions(input.actingUserId) };
  if (conversationId && conversationId !== "default") {
    const conversation = await backend.retrieveConversation(
      conversationId,
      options,
    );
    if (agentId && agentId !== conversation.agent_id) {
      throw new Error(
        "The conversation does not belong to the requested agent.",
      );
    }
    agentId = conversation.agent_id ?? undefined;
  }
  if (!agentId) throw new Error("The default conversation requires agent_id.");
  if (!conversationId) {
    const conversation = await backend.createConversation(
      { agent_id: agentId, ...(input.senderAgentId ? { hidden: true } : {}) },
      options,
    );
    conversationId = conversation.id;
  }
  if (
    agentId === input.currentConversation?.agentId &&
    conversationId === input.currentConversation?.conversationId
  ) {
    throw new Error(
      "Cannot message the current conversation. Use a Monitor or schedule for self-invocation.",
    );
  }
  return { agentId, conversationId };
}
