/**
 * Channel pairing store.
 *
 * Handles the pairing flow for channels with dm_policy: "pairing".
 * When an unknown user messages the bot, they get a pairing code.
 * The user runs `/channels <channel> pair <code>` to approve the connection.
 *
 * Persisted in ~/.letta/channels/<channel>/pairing.yaml.
 *
 * Reference: lettabot src/pairing/store.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { getChannelDir, getChannelPairingPath } from "./config";
import type { ApprovedUser, PairingStore, PendingPairing } from "./types";

// ── Constants ─────────────────────────────────────────────────────

/** Pairing codes expire after 15 minutes. */
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/** Maximum pending pairing codes to keep. */
const MAX_PENDING_CODES = 50;

/** Code character set (uppercase alphanumeric, no ambiguous chars). */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I, O, 0, 1

// ── In-memory store ───────────────────────────────────────────────

const stores = new Map<string, PairingStore>();

let loadPairingStoreOverride:
  | ((channelId: string) => PairingStore | null)
  | null = null;
let savePairingStoreOverride:
  | ((channelId: string, store: PairingStore) => void)
  | null = null;

function normalizeAccountId(accountId?: string): string {
  return accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
}

function getStore(channelId: string): PairingStore {
  let store = stores.get(channelId);
  if (!store) {
    store = { pending: [], approved: [] };
    stores.set(channelId, store);
  }
  return store;
}

// ── Load/save ─────────────────────────────────────────────────────

export function loadPairingStore(channelId: string): void {
  if (loadPairingStoreOverride) {
    const overridden = loadPairingStoreOverride(channelId);
    if (overridden === null) {
      return;
    }
    stores.set(channelId, {
      pending: [...overridden.pending],
      approved: [...overridden.approved],
    });
    return;
  }

  const path = getChannelPairingPath(channelId);
  if (!existsSync(path)) return;

  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<PairingStore>;
    stores.set(channelId, {
      pending: parsed.pending ?? [],
      approved: parsed.approved ?? [],
    });
  } catch {
    // Corrupted — start fresh.
  }
}

function savePairingStore(channelId: string): void {
  const store = getStore(channelId);
  if (savePairingStoreOverride) {
    savePairingStoreOverride(channelId, {
      pending: [...store.pending],
      approved: [...store.approved],
    });
    return;
  }

  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    getChannelPairingPath(channelId),
    `${JSON.stringify(store, null, 2)}\n`,
    "utf-8",
  );
}

// ── Code generation ───────────────────────────────────────────────

function generateCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// ── Pairing operations ────────────────────────────────────────────

/**
 * Check if a user is approved (has completed pairing).
 */
export function isUserApproved(
  channelId: string,
  userId: string,
  accountId?: string,
): boolean {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(accountId);
  return store.approved.some(
    (u) =>
      u.senderId === userId &&
      normalizeAccountId(u.accountId) === normalizedAccountId,
  );
}

/**
 * Create a pending pairing code for an unknown user.
 * Returns the generated code.
 */
export function createPairingCode(
  channelId: string,
  userId: string,
  chatId: string,
  username?: string,
  accountId?: string,
): string {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(accountId);

  // Remove any existing pending code for this user
  store.pending = store.pending.filter(
    (p) =>
      !(
        p.senderId === userId &&
        normalizeAccountId(p.accountId) === normalizedAccountId
      ),
  );

  // Prune expired codes
  const now = Date.now();
  store.pending = store.pending.filter(
    (p) => new Date(p.expiresAt).getTime() > now,
  );

  // Enforce max pending limit
  while (store.pending.length >= MAX_PENDING_CODES) {
    store.pending.shift();
  }

  const code = generateCode();
  const pending: PendingPairing = {
    accountId: normalizedAccountId,
    code,
    senderId: userId,
    senderName: username,
    chatId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(now + PAIRING_CODE_TTL_MS).toISOString(),
  };

  store.pending.push(pending);
  savePairingStore(channelId);

  return code;
}

/**
 * Validate and consume a pairing code.
 * Returns the pending pairing info if valid, null if invalid/expired.
 */
export function consumePairingCode(
  channelId: string,
  code: string,
  accountId?: string,
): PendingPairing | null {
  const store = getStore(channelId);
  const upperCode = code.toUpperCase();
  const normalizedAccountId =
    accountId === undefined ? undefined : normalizeAccountId(accountId);

  const matches = store.pending
    .map((pending, index) => ({ pending, index }))
    .filter(
      ({ pending }) =>
        pending.code === upperCode &&
        (normalizedAccountId === undefined ||
          normalizeAccountId(pending.accountId) === normalizedAccountId),
    );

  if (matches.length > 1) {
    return null;
  }

  const index = matches[0]?.index ?? -1;
  if (index === -1) return null;

  const pending = store.pending[index] as PendingPairing;
  const pendingAccountId = normalizeAccountId(pending.accountId);

  // Check expiry
  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    // Remove expired code
    store.pending.splice(index, 1);
    savePairingStore(channelId);
    return null;
  }

  // Remove from pending
  store.pending.splice(index, 1);

  // Add to approved (if not already)
  if (
    !store.approved.some(
      (u) =>
        u.senderId === pending.senderId &&
        normalizeAccountId(u.accountId) === pendingAccountId,
    )
  ) {
    const approved: ApprovedUser = {
      accountId: pendingAccountId,
      senderId: pending.senderId,
      senderName: pending.senderName,
      approvedAt: new Date().toISOString(),
    };
    store.approved.push(approved);
  }

  savePairingStore(channelId);
  return pending;
}

/**
 * Get all pending pairing codes for a channel.
 * Filters out expired codes.
 */
export function getPendingPairings(
  channelId: string,
  accountId?: string,
): PendingPairing[] {
  const store = getStore(channelId);
  const now = Date.now();
  const normalizedAccountId =
    accountId === undefined ? undefined : normalizeAccountId(accountId);
  return store.pending.filter(
    (p) =>
      new Date(p.expiresAt).getTime() > now &&
      (normalizedAccountId === undefined ||
        normalizeAccountId(p.accountId) === normalizedAccountId),
  );
}

/**
 * Get all approved users for a channel.
 */
export function getApprovedUsers(
  channelId: string,
  accountId?: string,
): ApprovedUser[] {
  const normalizedAccountId =
    accountId === undefined ? undefined : normalizeAccountId(accountId);
  return getStore(channelId).approved.filter(
    (user) =>
      normalizedAccountId === undefined ||
      normalizeAccountId(user.accountId) === normalizedAccountId,
  );
}

/**
 * Roll back a pairing approval.
 * Re-adds the pending code and removes the approved user entry.
 * Used when route creation fails after pairing was consumed.
 */
export function rollbackPairingApproval(
  channelId: string,
  pending: PendingPairing,
): void {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(pending.accountId);

  // Remove from approved
  store.approved = store.approved.filter(
    (u) =>
      !(
        u.senderId === pending.senderId &&
        normalizeAccountId(u.accountId) === normalizedAccountId
      ),
  );

  // Re-add to pending
  store.pending.push(pending);

  savePairingStore(channelId);
}

export function removePairingStateForAccount(
  channelId: string,
  accountId: string,
): { pendingRemoved: number; approvedRemoved: number } {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(accountId);
  const nextPending = store.pending.filter(
    (pending) => normalizeAccountId(pending.accountId) !== normalizedAccountId,
  );
  const nextApproved = store.approved.filter(
    (approved) =>
      normalizeAccountId(approved.accountId) !== normalizedAccountId,
  );

  const pendingRemoved = store.pending.length - nextPending.length;
  const approvedRemoved = store.approved.length - nextApproved.length;

  if (pendingRemoved === 0 && approvedRemoved === 0) {
    return { pendingRemoved, approvedRemoved };
  }

  store.pending = nextPending;
  store.approved = nextApproved;
  savePairingStore(channelId);
  return { pendingRemoved, approvedRemoved };
}

/**
 * Clear all pairing state (for testing).
 */
export function clearPairingStores(): void {
  stores.clear();
}

export function __testOverrideLoadPairingStore(
  fn: ((channelId: string) => PairingStore | null) | null,
): void {
  loadPairingStoreOverride = fn;
}

export function __testOverrideSavePairingStore(
  fn: ((channelId: string, store: PairingStore) => void) | null,
): void {
  savePairingStoreOverride = fn;
}
