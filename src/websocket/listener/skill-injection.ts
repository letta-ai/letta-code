import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { consumeQueuedSkillContent } from "../../tools/impl/skillContentRegistry";

/**
 * Append queued Skill tool content as a trailing user message.
 *
 * Ordering is preserved: existing messages stay in place and skill content,
 * when present, is appended at the end.
 */
export function injectQueuedSkillContent(
  messages: Array<MessageCreate | ApprovalCreate>,
): Array<MessageCreate | ApprovalCreate> {
  const skillContents = consumeQueuedSkillContent();
  if (skillContents.length === 0) {
    return messages;
  }

  return [
    ...messages,
    {
      role: "user",
      otid: crypto.randomUUID(),
      content: skillContents.map((sc) => ({
        type: "text" as const,
        text: sc.content,
      })),
    },
  ];
}
