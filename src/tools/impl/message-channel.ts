/**
 * ChannelGateway's local MessageChannel execution binding.
 *
 * The canonical contract lives in channels/message-channel-executor. This file
 * only resolves local persisted routes, running adapters, and proactive Slack
 * accounts for the injected agent/conversation scope.
 */

import {
  createMessageChannelExternalToolResult,
  type ExecuteMessageChannelOptions,
  executeMessageChannel,
  executeMessageChannelExternalTool,
  type MessageChannelExecutionResolver,
} from "@/channels/message-channel-executor";
import type { MessageChannelIdempotencyScope } from "@/channels/message-channel-idempotency";
import type { MessageChannelArgs } from "@/channels/message-channel-types";
import {
  isSupportedChannelId,
  loadChannelPlugin,
} from "@/channels/plugin-registry";
import { getChannelRegistry } from "@/channels/registry";
import { resolveEligibleProactiveSlackAccount } from "@/channels/slack/proactive-accounts";
import { createProactiveSlackTransport } from "@/channels/slack/proactive-route";
import type { ExternalToolCallResult } from "@/types/app-server-protocol";

function createLocalMessageChannelResolver(): MessageChannelExecutionResolver {
  return {
    isSupportedChannel: isSupportedChannelId,
    async resolveRoutedContext(params) {
      const registry = getChannelRegistry();
      if (!registry) {
        return "Error: Channel system is not initialized. Start with --channels flag.";
      }
      const route = registry.getRouteForScope(
        params.channel,
        params.chatId,
        params.scope.agentId,
        params.scope.conversationId,
        params.accountId,
      );
      if (!route) return null;

      const adapter = registry.getAdapter(params.channel, route.accountId);
      if (!adapter) {
        return `Error: Channel "${params.channel}" is not configured or not running.`;
      }
      if (!adapter.isRunning()) {
        return `Error: Channel "${params.channel}" is not currently running.`;
      }

      const plugin = await loadChannelPlugin(params.channel);
      if (!plugin.messageActions) {
        return `Error: Channel "${params.channel}" does not expose MessageChannel actions.`;
      }
      return {
        route,
        transport: adapter,
        messageActions: plugin.messageActions,
      };
    },
    async resolveProactiveContext(params) {
      if (params.channel !== "slack") {
        return `Error: Explicit MessageChannel targets are not supported on ${params.channel}.`;
      }
      const eligibleAccount = resolveEligibleProactiveSlackAccount({
        agentId: params.scope.agentId,
        accountId: params.accountId,
      });
      if (typeof eligibleAccount === "string") return eligibleAccount;

      const plugin = await loadChannelPlugin(params.channel);
      const messageActions = plugin.messageActions;
      const resolveTarget = messageActions?.resolveMessageTarget;
      if (!messageActions || !resolveTarget) {
        return "Error: Explicit MessageChannel targets are not supported on slack.";
      }
      const target = await resolveTarget({
        account: eligibleAccount.account,
        target: params.target,
      });
      return {
        accountId: eligibleAccount.account.accountId,
        target,
        transport: createProactiveSlackTransport({
          adapter: eligibleAccount.adapter,
          accountId: eligibleAccount.account.accountId,
          target,
          agentId: params.scope.agentId,
          conversationId: params.scope.conversationId,
        }),
        messageActions,
      };
    },
  };
}

function resolveLocalMessageChannelExecution(
  args: MessageChannelArgs,
  idempotencyScope?: MessageChannelIdempotencyScope | null,
): ExecuteMessageChannelOptions | string {
  if (!getChannelRegistry()) {
    return "Error: Channel system is not initialized. Start with --channels flag.";
  }
  if (!args.parentScope) {
    return "Error: MessageChannel requires execution scope (agentId + conversationId).";
  }
  return {
    scope: args.parentScope,
    resolver: createLocalMessageChannelResolver(),
    channelTurnSources: args.channelTurnSources,
    idempotencyScope,
  };
}

export async function message_channel(
  args: MessageChannelArgs,
  idempotencyScope?: MessageChannelIdempotencyScope | null,
): Promise<string> {
  const execution = resolveLocalMessageChannelExecution(args, idempotencyScope);
  return typeof execution === "string"
    ? execution
    : await executeMessageChannel(args, execution);
}

export async function executeLocalMessageChannelExternalTool(
  args: MessageChannelArgs,
  idempotencyScope?: MessageChannelIdempotencyScope | null,
): Promise<ExternalToolCallResult> {
  const execution = resolveLocalMessageChannelExecution(args, idempotencyScope);
  return typeof execution === "string"
    ? createMessageChannelExternalToolResult(execution)
    : await executeMessageChannelExternalTool(args, execution);
}
