import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";

export type AttributedMessageCreate = MessageCreate & {
  attribution?: { acting_user_id?: string };
};

export function withMessageAttribution<T extends MessageCreate>(
  message: T,
  actingUserId?: string,
): T & AttributedMessageCreate {
  const attributed: T & AttributedMessageCreate = message;
  if (
    message.role !== "user" ||
    attributed.attribution !== undefined ||
    !actingUserId
  ) {
    return attributed;
  }
  return { ...message, attribution: { acting_user_id: actingUserId } };
}
