import { listChannelAccounts } from "../accounts";
import { getChannelRegistry } from "../registry";
import type { ChannelAdapter, SlackChannelAccount } from "../types";

export interface EligibleProactiveSlackAccount {
  account: SlackChannelAccount;
  adapter: ChannelAdapter;
}

export function listEligibleProactiveSlackAccounts(
  agentId: string,
): EligibleProactiveSlackAccount[] {
  const registry = getChannelRegistry();
  if (!registry) {
    return [];
  }

  const accounts = listChannelAccounts("slack");

  const eligible: EligibleProactiveSlackAccount[] = [];
  for (const account of accounts) {
    if (account.channel !== "slack" || account.agentId !== agentId) {
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
  const eligible = listEligibleProactiveSlackAccounts(params.agentId);

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
