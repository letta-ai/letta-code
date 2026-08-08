import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { consumeQueuedSkillContent } from "@/tools/impl/skill-content-registry";
import type { StreamDelta } from "@/types/protocol_v2";
import { emitCanonicalMessageDelta } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime } from "./types";

interface SkillInjectionContext {
  socket: ListenerTransport;
  runtime: ConversationRuntime;
  agentId?: string | null;
  conversationId?: string | null;
}

/**
 * Append queued Skill tool content as a trailing user message.
 *
 * Ordering is preserved: existing messages stay in place and skill content,
 * when present, is appended at the end.
 */
export function injectQueuedSkillContent(
  messages: Array<MessageCreate | ApprovalCreate>,
  context?: SkillInjectionContext,
): Array<MessageCreate | ApprovalCreate> {
  const skillContents = consumeQueuedSkillContent();
  if (skillContents.length === 0) {
    return messages;
  }

  const skillMessage = {
    role: "user" as const,
    otid: crypto.randomUUID(),
    content: skillContents.map((sc) => ({
      type: "text" as const,
      text: sc.content,
    })),
  };

  if (context) {
    emitCanonicalMessageDelta(
      context.socket,
      context.runtime,
      {
        type: "message",
        id: `user-msg-${crypto.randomUUID()}`,
        date: new Date().toISOString(),
        message_type: "user_message",
        content: skillMessage.content,
        otid: skillMessage.otid,
      } as StreamDelta,
      {
        agent_id: context.agentId,
        conversation_id: context.conversationId,
      },
    );
  }

  return [...messages, skillMessage];
}
