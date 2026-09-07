import type {
  ExternalToolDefinitionPayload,
  RuntimeScope,
} from "@/types/app-server-protocol";
import { getChannelAccount } from "./accounts";
import { buildMessageChannelExternalToolDefinition } from "./message-channel-tool-definition";
import { resolveLocalMessageChannelToolChannels } from "./message-tool";
import { listEligibleProactiveSlackAccounts } from "./slack/proactive-accounts";
import type { ChannelTurnSource } from "./types";

export async function buildGatewayMessageChannelTool(
  sources: ChannelTurnSource[],
  runtime?: RuntimeScope,
): Promise<ExternalToolDefinitionPayload | null> {
  const channelScopes =
    sources.length > 0
      ? sources.map((source) => ({
          channelId: source.channel,
          accountId: source.accountId ?? null,
          routedDestinationKey: JSON.stringify({
            channel: source.channel,
            accountId: source.accountId ?? null,
            chatId: source.chatId,
            threadId: source.threadId ?? null,
          }),
        }))
      : runtime
        ? listEligibleProactiveSlackAccounts({
            agentId: runtime.agent_id,
          }).map(({ account }) => ({
            channelId: "slack",
            accountId: account.accountId,
          }))
        : [];
  const toolScopes = channelScopes.filter(
    ({ channelId, accountId }) =>
      !accountId ||
      getChannelAccount(channelId, accountId)?.replyMode !== "relay",
  );
  if (toolScopes.length === 0) return null;

  return buildMessageChannelExternalToolDefinition({
    channels: await resolveLocalMessageChannelToolChannels({
      channels: toolScopes,
    }),
    scoped: sources.length > 0,
    allowProactiveTargets: true,
  });
}
