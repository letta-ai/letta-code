/**
 * MessageChannel tool — sends messages to external channels.
 *
 * Uses parentScope (injected per-execution by manager.ts executeTool())
 * for agent+conversation authorization. Does NOT use global context
 * singleton, which is unsafe in the listener's multi-runtime model.
 */

import { getChannelRegistry } from "../../channels/registry";
import type { ChannelRoute } from "../../channels/types";

interface MessageChannelArgs {
  channel: string;
  chat_id: string;
  text: string;
  reply_to_message_id?: string;
  /** Injected by executeTool() — NOT read from global context. */
  parentScope?: { agentId: string; conversationId: string };
}

export async function message_channel(
  args: MessageChannelArgs,
): Promise<string> {
  const registry = getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized. Start with --channels flag.";
  }

  const adapter = registry.getAdapter(args.channel);
  if (!adapter) {
    return `Error: Channel "${args.channel}" is not configured or not running.`;
  }

  if (!adapter.isRunning()) {
    return `Error: Channel "${args.channel}" is not currently running.`;
  }

  // Per-agent+conversation authorization via injected scope.
  // parentScope comes from executeTool() options in manager.ts,
  // NOT the global context singleton (agent/context.ts).
  const scope = args.parentScope;
  if (!scope) {
    return "Error: MessageChannel requires execution scope (agentId + conversationId).";
  }

  const route: ChannelRoute | null = registry.getRoute(
    args.channel,
    args.chat_id,
  );
  if (
    !route ||
    route.agentId !== scope.agentId ||
    route.conversationId !== scope.conversationId
  ) {
    return `Error: No route for chat_id "${args.chat_id}" on "${args.channel}" for this agent/conversation.`;
  }

  try {
    const result = await adapter.sendMessage({
      channel: args.channel,
      chatId: args.chat_id,
      text: args.text,
      replyToMessageId: args.reply_to_message_id,
    });

    return `Message sent to ${args.channel} (message_id: ${result.messageId})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return `Error sending message to ${args.channel}: ${msg}`;
  }
}
