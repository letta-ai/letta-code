/**
 * Account-scoped store records for pairing and discovered bind targets.
 * Kept out of `types.ts` so that file stays under the 1,000-line ceiling.
 */

export interface PendingPairing {
  accountId?: string;
  code: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovedUser {
  accountId?: string;
  senderId: string;
  senderName?: string;
  approvedAt: string;
}

export interface PairingStore {
  pending: PendingPairing[];
  approved: ApprovedUser[];
}

export interface ChannelBindableTarget {
  accountId?: string;
  targetId: string;
  targetType: "channel";
  chatId: string;
  label: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastMessageId?: string;
}
