import type { RuntimeScope } from "@/types/protocol_v2";

export async function handleChannelsSlashCommand(
  runtime: RuntimeScope,
  args: string | undefined,
): Promise<string> {
  const parts = (args ?? "").trim().split(/\s+/);
  const [subCmd, action, ...rest] = parts;
  const agentId = runtime.agent_id;
  const conversationId = runtime.conversation_id;

  if (subCmd === "status") {
    const { listChannelAccountSnapshots } = await import("./service");
    const { getRoutesForChannel, loadRoutes } = await import("./routing");
    const { getPendingPairings, getApprovedUsers, loadPairingStore } =
      await import("./pairing");
    const { getSupportedChannelIds } = await import("./plugin-registry");
    const lines: string[] = [];
    for (const channelId of getSupportedChannelIds()) {
      const accounts = listChannelAccountSnapshots(channelId);
      if (accounts.length === 0) {
        lines.push(`${channelId}: not configured`);
        continue;
      }
      loadRoutes(channelId);
      loadPairingStore(channelId);
      lines.push(
        `${channelId}: accounts=${accounts.length}, enabled=${accounts.some((account) => account.enabled)}, ` +
          `policy=${accounts[0]?.dmPolicy ?? "unknown"}, routes=${getRoutesForChannel(channelId).length}, ` +
          `pending=${getPendingPairings(channelId).length}, approved=${getApprovedUsers(channelId).length}`,
      );
    }
    return lines.join("\n") || "No channels configured.";
  }

  const {
    getChannelDisplayName,
    getSupportedChannelIds,
    isSupportedChannelId,
  } = await import("./plugin-registry");
  if (!subCmd || !isSupportedChannelId(subCmd)) {
    return `Usage: /channels <status|${getSupportedChannelIds().join("|")}> ...`;
  }

  const channelId = subCmd;
  const displayName = getChannelDisplayName(channelId);
  const accountIdFlag = rest.indexOf("--account-id");
  const accountId =
    accountIdFlag >= 0 ? (rest[accountIdFlag + 1] ?? undefined) : undefined;

  if (action === "pair") {
    const code = rest[0];
    if (!code) return `Usage: /channels ${channelId} pair <code>`;
    const { completePairing } = await import("./registry");
    const { loadRoutes } = await import("./routing");
    const { loadPairingStore } = await import("./pairing");
    loadRoutes(channelId);
    loadPairingStore(channelId);
    const result = completePairing(
      channelId,
      code,
      agentId,
      conversationId,
      accountId,
    );
    return result.success
      ? `Pairing approved! Chat ${result.chatId} is now bound to this agent/conversation.`
      : `Pairing failed: ${result.error}`;
  }

  if (action === "enable") {
    const chatIdFlag = rest.indexOf("--chat-id");
    const chatId = chatIdFlag >= 0 ? rest[chatIdFlag + 1] : undefined;
    if (!chatId) {
      return `Usage: /channels ${channelId} enable --chat-id <id> [--account-id <id>]`;
    }
    const { getChannelAccount, listChannelAccounts } = await import(
      "./accounts"
    );
    const { addRoute, loadRoutes } = await import("./routing");
    let resolvedAccountId = accountId?.trim();
    if (resolvedAccountId) {
      if (!getChannelAccount(channelId, resolvedAccountId)) {
        return `Unknown ${displayName} account: ${resolvedAccountId}`;
      }
    } else {
      const accounts = listChannelAccounts(channelId);
      if (accounts.length === 0) return `${displayName} is not configured yet.`;
      if (accounts.length > 1) {
        return `${displayName} has multiple accounts. Re-run with --account-id <id>.`;
      }
      resolvedAccountId = accounts[0]?.accountId;
    }
    if (!resolvedAccountId) {
      return `Could not resolve a ${displayName} account for this route.`;
    }
    loadRoutes(channelId);
    addRoute(channelId, {
      accountId: resolvedAccountId,
      chatId,
      agentId,
      conversationId,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    return `Route created: ${channelId}:${chatId} → ${agentId}/${conversationId}`;
  }

  if (action === "disable") {
    const { loadRoutes, removeRoutesForScope } = await import("./routing");
    loadRoutes(channelId);
    const removed = removeRoutesForScope(channelId, agentId, conversationId);
    return removed > 0
      ? `Removed ${removed} route(s) for this agent/conversation.`
      : "No routes found for this agent/conversation.";
  }

  return `Usage: /channels ${channelId} <pair|enable|disable>`;
}
