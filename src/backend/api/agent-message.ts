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
  if (!sender.agentId && !sender.conversationId) return "";
  const address = sender.conversationId
    ? `, conversation ${sender.conversationId}`
    : "";
  // `--agent` with a conv-... ID is rejected by startup validation.
  const isDefault = sender.conversationId === "default";
  const cliTarget = isDefault
    ? `--agent ${sender.agentId} --conversation default`
    : `--conversation ${sender.conversationId}`;
  const toolTarget = isDefault
    ? `agent_id ${sender.agentId} and conversation_id default`
    : `conversation_id ${sender.conversationId}`;
  const instruction = !noWait
    ? "The sender will only see the final message you generate (not tool calls or reasoning). Include your answer in your final response."
    : sender.conversationId
      ? `To reply, call SendAgentMessage with ${toolTarget}. Only if that tool is unavailable, run letta -p ${cliTarget} --no-wait "your reply". Ordinary assistant output is not forwarded to the sender.`
      : "Ordinary assistant output is not forwarded to the sender. No return conversation was supplied.";
  return `<system-reminder>\nThis message is from agent ${sender.agentId ?? "(agentless)"}${address}.\n${instruction}\n</system-reminder>\n\n`;
}

export function validateAddress(
  value: string | undefined,
  kind: "agent" | "conversation",
): string | undefined {
  if (!value) return undefined;
  if (kind === "conversation" && value === "default") return value;
  const prefix = kind === "agent" ? "agent" : "(local-)?conv";
  if (!new RegExp(`^${prefix}-[a-zA-Z0-9-]+$`).test(value)) {
    throw new Error(`Invalid ${kind} ID: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Recovery commands for a send; `--agent` is only needed for `default`. */
export function buildAgentMessageRecoveryCommands(destination: {
  agentId?: string | null;
  conversationId: string;
}): { status_command: string; messages_command: string } {
  const target = `${destination.agentId ? `--agent ${destination.agentId} ` : ""}--conversation ${destination.conversationId}`;
  return {
    status_command: `letta messages status ${target}`,
    messages_command: `letta messages list ${target}`,
  };
}

/**
 * Shared destination lookup for CLI sends and the SendAgentMessage tool.
 *
 * A non-default conversation ID is a complete address: the enqueue endpoint
 * derives the agent from it and reports it in the receipt, so the conversation
 * is not read and `agentId` is returned only when the caller supplied it. A
 * caller-supplied `agentId` is forwarded; the server owns any mismatch check.
 */
export async function resolveAgentMessageDestination(
  input: {
    agentId?: string;
    conversationId?: string;
    senderAgentId?: string;
    actingUserId?: string | null;
    /** Calling runtime, independent of optional sender attribution overrides. */
    currentConversation?: { agentId?: string; conversationId?: string };
  },
  backend: Pick<Backend, "createConversation">,
  signal?: AbortSignal,
): Promise<{ agentId?: string; conversationId: string }> {
  const agentId = validateAddress(input.agentId, "agent");
  let conversationId = validateAddress(input.conversationId, "conversation");
  if (!agentId && !conversationId) {
    throw new Error("Choose a destination with agent_id or conversation_id.");
  }
  const options = { signal, ...actingUserRequestOptions(input.actingUserId) };
  if (!conversationId || conversationId === "default") {
    if (!agentId) {
      throw new Error("The default conversation requires agent_id.");
    }
    if (!conversationId) {
      const conversation = await backend.createConversation(
        {
          agent_id: agentId,
          ...(input.senderAgentId ? { hidden: true } : {}),
        },
        options,
      );
      conversationId = conversation.id;
    }
  }
  const current = input.currentConversation;
  // Conversation IDs are unique except `default`, which is scoped by agent.
  const isCurrent =
    conversationId === current?.conversationId &&
    (conversationId !== "default" || agentId === current?.agentId);
  if (isCurrent) {
    throw new Error(
      "Cannot message the current conversation. Use Monitor for external events or Wake for timed self-invocation.",
    );
  }
  return agentId ? { agentId, conversationId } : { conversationId };
}
