import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { DiscoverClientSideSkillsOptions } from "@/agent/client-skills";
import {
  findUserInvocableSkillInvocation,
  renderUserInvocableSkillInvocation,
} from "@/tools/impl/user-invocable-skill";

type IncomingMessages = Array<MessageCreate | ApprovalCreate>;

/** Expand explicit text-only user messages without disturbing approvals or other content. */
export async function expandListenerUserSkillMessages(
  messages: IncomingMessages,
  options: DiscoverClientSideSkillsOptions,
  isReservedCommand: (commandId: string) => boolean,
): Promise<IncomingMessages> {
  let changed = false;
  const expanded: IncomingMessages = [];
  for (const message of messages) {
    if (!("role" in message) || message.role !== "user") {
      expanded.push(message);
      continue;
    }
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content.length === 1 && content[0]?.type === "text"
          ? content[0].text
          : null;
    if (!text?.trim().startsWith("/")) {
      expanded.push(message);
      continue;
    }

    const commandId = text.trim().split(/\s+/)[0]?.slice(1) ?? "";
    const invocation = isReservedCommand(commandId)
      ? null
      : await findUserInvocableSkillInvocation(text, options);
    if (!invocation) {
      expanded.push(message);
      continue;
    }
    changed = true;
    expanded.push({
      ...message,
      content: [
        {
          type: "text",
          text: await renderUserInvocableSkillInvocation(invocation),
        },
      ],
    });
  }
  return changed ? expanded : messages;
}
