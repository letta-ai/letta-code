import { getChannelAccount, LEGACY_CHANNEL_ACCOUNT_ID } from "../accounts";
import { getChannelRegistry } from "../registry";
import { getRoutesForChannel, loadRoutes } from "../routing";
import type { ChannelAdapter, SlackChannelAccount } from "../types";

export interface EligibleProactiveSlackAccount {
  account: SlackChannelAccount;
  adapter: ChannelAdapter;
}

export function listEligibleProactiveSlackAccounts(params: {
  agentId: string;
  conversationId: string;
}): EligibleProactiveSlackAccount[] {
  const registry = getChannelRegistry();
  if (!registry) {
    return [];
  }

  loadRoutes("slack");
  const seen = new Set<string>();

  const eligible: EligibleProactiveSlackAccount[] = [];
  for (const route of getRoutesForChannel("slack")) {
    if (
      route.agentId !== params.agentId ||
      route.conversationId !== params.conversationId ||
      !route.enabled
    ) {
      continue;
    }

    const accountId = route.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    if (seen.has(accountId)) {
      continue;
    }
    seen.add(accountId);

    const account = getChannelAccount("slack", accountId);
    if (
      !account ||
      account.channel !== "slack" ||
      account.agentId !== params.agentId
    ) {
      continue;
    }

    const adapter = registry.getAdapter("slack", account.accountId);
    if (!adapter?.isRunning()) {
      continue;
    }
    eligible.push({
      account,
      adapter,
    });
  }

  return eligible;
}

export function resolveEligibleProactiveSlackAccount(params: {
  agentId: string;
  conversationId: string;
  accountId?: string | null;
}): EligibleProactiveSlackAccount | string {
  const eligible = listEligibleProactiveSlackAccounts({
    agentId: params.agentId,
    conversationId: params.conversationId,
  });

  if (params.accountId) {
    const matched = eligible.find(
      ({ account }) => account.accountId === params.accountId,
    );
    if (!matched) {
      return `Error: Slack account "${params.accountId}" is not available for proactive sends in this agent scope.`;
    }
    return matched;
  }

  if (eligible.length === 0) {
    return "Error: No proactive Slack accounts are available for this agent.";
  }

  if (eligible.length > 1) {
    return "Error: Multiple proactive Slack accounts are available for this agent. Pass accountId.";
  }

  return eligible[0] as EligibleProactiveSlackAccount;
}
