import { cloneAccount } from "./account-normalization";
import { CHANNEL_SECRET_REFS_KEY } from "./credential-utils";
import type { ChannelAccount } from "./types";

type ChannelAccountWithSecretRefs = ChannelAccount & {
  [CHANNEL_SECRET_REFS_KEY]?: Record<string, true>;
};

function normalizeAccountForMutationCompare(
  account: ChannelAccount,
): ChannelAccount {
  const normalized = cloneAccount(account) as ChannelAccountWithSecretRefs;
  delete normalized[CHANNEL_SECRET_REFS_KEY];
  return normalized;
}

export function accountsMatchForMutation(
  left: ChannelAccount | null,
  right: ChannelAccount | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    JSON.stringify(normalizeAccountForMutationCompare(left)) ===
    JSON.stringify(normalizeAccountForMutationCompare(right))
  );
}
