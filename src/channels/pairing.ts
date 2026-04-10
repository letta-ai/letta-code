/**
 * Channel pairing store.
 *
 * Handles the pairing flow for channels with dm_policy: "pairing".
 * When an unknown user messages the bot, they get a pairing code.
 * The user runs `/channels telegram pair <code>` to approve the connection.
 *
 * Persisted in ~/.letta/channels/<channel>/pairing.yaml.
 *
 * Reference: lettabot src/pairing/store.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });

  const store = getStore(channelId);
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
export function isUserApproved(channelId: string, userId: string): boolean {
  const store = getStore(channelId);
  return store.approved.some((u) => u.telegramUserId === userId);
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
): string {
  const store = getStore(channelId);

  // Remove any existing pending code for this user
  store.pending = store.pending.filter((p) => p.telegramUserId !== userId);

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
    code,
    telegramUserId: userId,
    telegramUsername: username,
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
): PendingPairing | null {
  const store = getStore(channelId);
  const upperCode = code.toUpperCase();

  const index = store.pending.findIndex((p) => p.code === upperCode);
  if (index === -1) return null;

  const pending = store.pending[index] as PendingPairing;

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
    !store.approved.some((u) => u.telegramUserId === pending.telegramUserId)
  ) {
    const approved: ApprovedUser = {
      telegramUserId: pending.telegramUserId,
      telegramUsername: pending.telegramUsername,
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
export function getPendingPairings(channelId: string): PendingPairing[] {
  const store = getStore(channelId);
  const now = Date.now();
  return store.pending.filter((p) => new Date(p.expiresAt).getTime() > now);
}

/**
 * Get all approved users for a channel.
 */
export function getApprovedUsers(channelId: string): ApprovedUser[] {
  return getStore(channelId).approved;
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

  // Remove from approved
  store.approved = store.approved.filter(
    (u) => u.telegramUserId !== pending.telegramUserId,
  );

  // Re-add to pending
  store.pending.push(pending);

  savePairingStore(channelId);
}

/**
 * Clear all pairing state (for testing).
 */
export function clearPairingStores(): void {
  stores.clear();
}
