import type {
  ExternalToolDefinitionPayload,
  RuntimeScope,
} from "@/types/app-server-protocol";
import { getChannelAccount } from "./accounts";
import { sourceRouteKey } from "./gateway-sources";
import { buildMessageChannelExternalToolDefinition } from "./message-channel-tool-definition";
import { resolveLocalMessageChannelToolChannels } from "./message-tool";
import { listEligibleProactiveSlackAccounts } from "./slack/proactive-accounts";
import type { ChannelTurnSource } from "./types";

export async function buildGatewayMessageChannelTool(
  sources: ChannelTurnSource[],
  runtime?: RuntimeScope,
  policy?: { automaticRelay: boolean },
): Promise<ExternalToolDefinitionPayload | null> {
  const channelScopes =
    sources.length > 0
      ? sources.map((source) => ({
          channelId: source.channel,
          accountId: source.accountId ?? null,
          routedDestinationKey: sourceRouteKey(source),
        }))
      : runtime
        ? listEligibleProactiveSlackAccounts({
            agentId: runtime.agent_id,
          }).map(({ account }) => ({
            channelId: "slack",
            accountId: account.accountId,
          }))
        : [];
  const toolScopes =
    policy?.automaticRelay === true
      ? []
      : policy?.automaticRelay === false
        ? channelScopes
        : channelScopes.filter(
            ({ channelId, accountId }) =>
              !accountId ||
              getChannelAccount(channelId, accountId)?.replyMode !== "relay",
          );
  const routedDestinations = new Set(sources.map(sourceRouteKey));
  const exposedScopes =
    sources.length > 0 && routedDestinations.size > 1
      ? channelScopes
      : toolScopes;
  if (exposedScopes.length === 0) return null;

  const tool = await buildMessageChannelExternalToolDefinition({
    channels: await resolveLocalMessageChannelToolChannels({
      channels: exposedScopes,
    }),
    scoped: sources.length > 0,
    allowProactiveTargets: true,
  });
  const accountIds = [
    ...new Set(
      exposedScopes
        .map(({ accountId }) => accountId?.trim())
        .filter((accountId): accountId is string => Boolean(accountId)),
    ),
  ];
  if (sources.length > 0 && accountIds.length > 1) {
    tool.description += `\n\nCurrently routed accounts: ${accountIds.join(", ")}.`;
  }
  return tool;
}
