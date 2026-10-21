import { getChannelAccount } from "@/channels/accounts";
import type { ChannelMessageActionRoute } from "@/channels/plugin-types";
import { isTelegramChannelAccount } from "@/channels/types";
import { createTelegramMessageActionAdapter } from "./message-action-contract";

function richPrivateChatDefaultEnabled(
  route: ChannelMessageActionRoute,
): boolean {
  const accountId = route.accountId?.trim();
  if (!accountId) {
    return true;
  }
  const account = getChannelAccount("telegram", accountId);
  if (!account || !isTelegramChannelAccount(account)) {
    return true;
  }
  return account.richPrivateChatDefault !== false;
}

export const telegramMessageActions = createTelegramMessageActionAdapter({
  richPrivateChatDefaultEnabled,
});
