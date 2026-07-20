import { isUserApproved, loadPairingStore } from "./pairing";
import { getChannelDisplayName } from "./plugin-registry";
import { signalAllowedUsersIncludes } from "./signal/target";
import type {
  ChannelChatType,
  ChannelGroupSenderPolicy,
  DmPolicy,
} from "./types";
import { allowedUsersIncludes as whatsappAllowedUsersIncludes } from "./whatsapp/jid";

/**
 * Centralized sender access control for channel inbound traffic.
 *
 * Modeled on the Hermes gateway's authorization layer: one decision
 * function consulted on every inbound message (DMs and groups), an
 * env-var allowlist axis that works across all channels, and an
 * opt-in admin/user command tier that stays disabled until an
 * operator lists at least one admin.
 */

// ── Scope ─────────────────────────────────────────────────────────

export type ChannelAccessScope = "dm" | "group";

export function resolveChannelAccessScope(
  chatType: ChannelChatType | undefined,
): ChannelAccessScope {
  return chatType === "channel" ? "group" : "dm";
}

// ── Env-var allowlists ────────────────────────────────────────────

const GLOBAL_ALLOWED_USERS_ENV = "LETTA_CHANNELS_ALLOWED_USERS";
const GLOBAL_ADMIN_USERS_ENV = "LETTA_CHANNELS_ADMIN_USERS";
const GLOBAL_ALLOW_ALL_ENV = "LETTA_CHANNELS_ALLOW_ALL_USERS";

function channelEnvKey(channelId: string, suffix: string): string {
  const normalized = channelId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `LETTA_${normalized}_${suffix}`;
}

function parseUserList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isEnvFlagEnabled(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Union of the global and per-channel allowed-user env vars. */
export function getChannelEnvAllowedUsers(channelId: string): string[] {
  return [
    ...parseUserList(process.env[GLOBAL_ALLOWED_USERS_ENV]),
    ...parseUserList(process.env[channelEnvKey(channelId, "ALLOWED_USERS")]),
  ];
}

/** Union of the global and per-channel admin-user env vars. */
export function getChannelEnvAdminUsers(channelId: string): string[] {
  return [
    ...parseUserList(process.env[GLOBAL_ADMIN_USERS_ENV]),
    ...parseUserList(process.env[channelEnvKey(channelId, "ADMIN_USERS")]),
  ];
}

/** Explicit opt-out of sender gating (LETTA_CHANNELS_ALLOW_ALL_USERS=1). */
export function isChannelAllowAllUsersEnabled(channelId: string): boolean {
  return (
    isEnvFlagEnabled(process.env[GLOBAL_ALLOW_ALL_ENV]) ||
    isEnvFlagEnabled(process.env[channelEnvKey(channelId, "ALLOW_ALL_USERS")])
  );
}

// ── Sender access decisions ───────────────────────────────────────

/**
 * Minimal structural view of a channel account used for access
 * decisions, satisfied by every ChannelAccount variant including
 * custom plugin accounts.
 */
export interface ChannelAccessAccount {
  accountId: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  groupPolicy?: ChannelGroupSenderPolicy;
  adminUsers?: string[];
  userAllowedCommands?: string[];
}

export type ChannelSenderAccessDecision = "allow" | "deny" | "pair";

export interface ChannelSenderAccessInput {
  account: ChannelAccessAccount;
  channelId: string;
  senderId: string;
  chatType: ChannelChatType | undefined;
}

function effectiveAllowedUsers(
  account: ChannelAccessAccount,
  channelId: string,
): string[] {
  return [
    ...account.allowedUsers,
    ...(account.adminUsers ?? []),
    ...getChannelEnvAllowedUsers(channelId),
    ...getChannelEnvAdminUsers(channelId),
  ];
}

/**
 * Channel-aware allowlist membership. WhatsApp and Signal identities
 * have multiple representations (JID vs phone digits, UUID vs E.164),
 * so those channels match through their normalizing helpers.
 */
function allowlistMatches(
  channelId: string,
  allowed: string[],
  senderId: string,
): boolean {
  if (allowed.includes("*")) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  if (channelId === "whatsapp") {
    return whatsappAllowedUsersIncludes(allowed, senderId);
  }
  if (channelId === "signal") {
    return signalAllowedUsersIncludes(allowed, senderId);
  }
  return allowed.includes(senderId);
}

function isPairedApproved(
  channelId: string,
  senderId: string,
  accountId: string,
): boolean {
  if (isUserApproved(channelId, senderId, accountId)) {
    return true;
  }
  // Reload from disk on miss so standalone CLI pairing approvals apply
  // without a listener restart (mirrors the historical DM pairing path).
  loadPairingStore(channelId);
  return isUserApproved(channelId, senderId, accountId);
}

/**
 * Decide whether an inbound sender may reach the agent.
 *
 * Order of checks, most permissive first:
 * 1. Allow-all env flag → allow.
 * 2. Sender in the effective allowlist (account allowedUsers + adminUsers
 *    + env allowlists, `*` wildcard supported) → allow.
 * 3. Sender approved via pairing → allow (pairing grants are a union
 *    with the allowlist, not an alternative).
 * 4. Otherwise the scope policy decides:
 *    - group: `groupPolicy: "allowlist"` denies; an env allowlist being
 *      configured also denies (a configured allowlist restricts
 *      everywhere); default stays open for backwards compatibility.
 *    - dm: `dmPolicy` semantics — open allows (unless an env allowlist
 *      is configured), allowlist denies, pairing asks for a code.
 *
 * Slack exception: Slack DM `dmPolicy: "pairing"` is a legacy default
 * that was never enforced (the workspace membership is the trust
 * boundary and there is no Slack pairing UX), so it behaves as "open".
 * Explicit `dmPolicy: "allowlist"` and env allowlists ARE enforced.
 */
export function evaluateChannelSenderAccess(
  input: ChannelSenderAccessInput,
): ChannelSenderAccessDecision {
  const { account, channelId, senderId, chatType } = input;

  if (isChannelAllowAllUsersEnabled(channelId)) {
    return "allow";
  }

  const allowed = effectiveAllowedUsers(account, channelId);
  if (allowlistMatches(channelId, allowed, senderId)) {
    return "allow";
  }

  const envAllowlistConfigured =
    getChannelEnvAllowedUsers(channelId).length > 0;
  const scope = resolveChannelAccessScope(chatType);

  const restrictive =
    envAllowlistConfigured ||
    (scope === "group"
      ? (account.groupPolicy ?? "open") === "allowlist"
      : account.dmPolicy !== "open");
  if (!restrictive) {
    return "allow";
  }

  if (senderId && isPairedApproved(channelId, senderId, account.accountId)) {
    return "allow";
  }

  if (scope === "group") {
    return "deny";
  }

  if (account.dmPolicy === "pairing" && !envAllowlistConfigured) {
    // Slack never enforced its legacy "pairing" default and has no
    // pairing reply surface; keep workspace membership as the boundary.
    return channelId === "slack" ? "allow" : "pair";
  }

  return "deny";
}

const ACCESS_DENIED_NOUNS: Record<string, string> = {
  slack: "Slack app",
  discord: "Discord bot",
  whatsapp: "WhatsApp account",
  signal: "Signal account",
};

export function buildChannelAccessDeniedMessage(channelId: string): string {
  const noun = ACCESS_DENIED_NOUNS[channelId] ?? "bot";
  return `You are not on the allowed users list for this ${noun}.`;
}

// ── Admin/user command tiers ──────────────────────────────────────

/**
 * Read-only commands that stay reachable for every allowed user even
 * when command gating is enabled. Anything an operator lists in
 * `userAllowedCommands` is added on top; the floor is never removed.
 */
export const CHANNEL_COMMAND_FLOOR = ["help", "status", "whoami"] as const;

export interface ChannelCommandGate {
  /** Gating is active only when at least one admin is configured. */
  enabled: boolean;
  isAdmin: boolean;
  /** Normalized extra commands non-admins may run (floor excluded). */
  allowedCommands: string[];
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/** Resolve command aliases to the canonical name used for gating. */
export function canonicalizeChannelCommandName(name: string): string {
  const normalized = normalizeCommandName(name);
  return normalized === "reflect" ? "reflection" : normalized;
}

/**
 * Resolve the command tier for a sender. Mirrors Hermes's backward
 * compatibility rule: when no admin is configured for the account (or
 * via env), gating is disabled and every allowed user has full access.
 */
export function resolveChannelCommandGate(params: {
  account: ChannelAccessAccount;
  channelId: string;
  senderId: string;
}): ChannelCommandGate {
  const admins = [
    ...(params.account.adminUsers ?? []),
    ...getChannelEnvAdminUsers(params.channelId),
  ].filter((entry) => entry.length > 0);
  const enabled = admins.length > 0;
  const allowedCommands = (params.account.userAllowedCommands ?? [])
    .map(normalizeCommandName)
    .filter((name) => name.length > 0);
  return {
    enabled,
    isAdmin:
      !enabled || (!!params.senderId && admins.includes(params.senderId)),
    allowedCommands,
  };
}

export function canRunChannelCommand(
  gate: ChannelCommandGate,
  commandName: string,
): boolean {
  if (!gate.enabled || gate.isAdmin) {
    return true;
  }
  const normalized = normalizeCommandName(commandName);
  return (
    (CHANNEL_COMMAND_FLOOR as readonly string[]).includes(normalized) ||
    gate.allowedCommands.includes(normalized)
  );
}

function runnableCommandsForUser(gate: ChannelCommandGate): string[] {
  const seen = new Set<string>();
  const runnable: string[] = [];
  for (const name of [...CHANNEL_COMMAND_FLOOR, ...gate.allowedCommands]) {
    if (!seen.has(name)) {
      seen.add(name);
      runnable.push(name);
    }
  }
  return runnable;
}

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

export function buildChannelCommandDeniedMessage(
  channelId: string,
  commandName: string,
  gate: ChannelCommandGate,
): string {
  const runnable = runnableCommandsForUser(gate)
    .map((name) => `/${name}`)
    .join(", ");
  return [
    `${channelDisplayName(channelId)}: /${normalizeCommandName(commandName)} is limited to admins here.`,
    `Commands you can run: ${runnable}. Use /whoami to see your access.`,
  ].join("\n");
}

export function buildChannelWhoamiMessage(
  msg: {
    channel: string;
    senderId: string;
    senderName?: string;
    chatType?: ChannelChatType;
  },
  gate?: ChannelCommandGate,
): string {
  const scope =
    resolveChannelAccessScope(msg.chatType) === "dm" ? "DM" : "group/channel";
  const who = msg.senderName
    ? `${msg.senderName} (${msg.senderId})`
    : msg.senderId;
  const lines = [
    `You — ${channelDisplayName(msg.channel)} (${scope})`,
    `User ID: ${who}`,
  ];
  if (!gate || !gate.enabled) {
    lines.push(
      "Tier: unrestricted (no admin list configured for this account)",
      "Commands: all available",
    );
  } else if (gate.isAdmin) {
    lines.push("Tier: admin", "Commands: all available");
  } else {
    const runnable = runnableCommandsForUser(gate)
      .map((name) => `/${name}`)
      .join(", ");
    lines.push("Tier: user", `Commands you can run: ${runnable}`);
  }
  return lines.join("\n");
}
