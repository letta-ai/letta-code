import { listChannelAccounts } from "@/channels/accounts";
import { getChannelRegistry } from "@/channels/registry";
import type { ChannelAdapter, SlackChannelAccount } from "@/channels/types";
import { isSlackChannelAccount } from "@/channels/types";

export interface EligibleProactiveSlackAccount {
  account: SlackChannelAccount;
  adapter: ChannelAdapter;
}

export function listEligibleProactiveSlackAccounts(params: {
  agentId: string;
}): EligibleProactiveSlackAccount[] {
  const registry = getChannelRegistry();
  if (!registry) {
    return [];
  }

  const eligible: EligibleProactiveSlackAccount[] = [];
  for (const account of listChannelAccounts("slack")) {
    if (
      !account.enabled ||
      !isSlackChannelAccount(account) ||
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
  accountId?: string | null;
}): EligibleProactiveSlackAccount | string {
  const eligible = listEligibleProactiveSlackAccounts({
    agentId: params.agentId,
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
