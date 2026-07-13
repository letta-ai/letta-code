import { getChannelPluginMetadata } from "./plugin-registry";
import type { ChannelAccountPatch } from "./plugin-types";
import type { ChannelAccount } from "./types";
import {
  isCustomChannelAccount,
  isDiscordChannelAccount,
  isFirstPartyChannelId,
  isSlackChannelAccount,
  isTelegramChannelAccount,
} from "./types";

export const CHANNEL_SECRET_REFS_KEY = "__letta_secret_refs";
export const SECRET_PRESENT_PLACEHOLDER = "__letta_channel_secret_present__";
export const BUILTIN_CONFIG_SECRET_KEYS = ["bot_token", "auth"] as const;

const CONFIG_SECRET_FIELD_PREFIX = "config.";

export type MissingCredentialMessageScope = "account" | "channel";

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSecretPlaceholderValue(value: unknown): value is string {
  return value === SECRET_PRESENT_PLACEHOLDER;
}

export function isPresentSecretValue(value: unknown): value is string {
  return isSecretPlaceholderValue(value) || isNonEmptyString(value);
}

export function toConfigSecretFieldPath(key: string): string {
  return `${CONFIG_SECRET_FIELD_PREFIX}${key}`;
}

export function configSecretFieldPathToKey(fieldPath: string): string | null {
  if (!fieldPath.startsWith(CONFIG_SECRET_FIELD_PREFIX)) {
    return null;
  }
  const key = fieldPath.slice(CONFIG_SECRET_FIELD_PREFIX.length);
  return key.length > 0 ? key : null;
}

export function getPersistedSecretRefPaths(account: unknown): string[] {
  if (!account || typeof account !== "object") {
    return [];
  }
  const refs = (account as Record<string, unknown>)[CHANNEL_SECRET_REFS_KEY];
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    return [];
  }
  return Object.entries(refs).flatMap(([fieldPath, value]) =>
    value === true ? [fieldPath] : [],
  );
}

export function getConfigSchemaSecretKeys(channelId: string): string[] {
  try {
    return (
      getChannelPluginMetadata(channelId)
        .configSchema?.fields.filter((field) => field.type === "secret")
        .map((field) => field.key) ?? []
    );
  } catch {
    // Metadata lookup for user-installed plugins depends on local manifests.
    // Keep credential handling conservative if a plugin was removed or its
    // manifest is temporarily unreadable; existing persisted refs are handled
    // separately by getPersistedSecretRefPaths().
    return [];
  }
}

export function getConfigSecretKeys(
  channelId: string,
  existingRefPaths: Iterable<string> = [],
): Set<string> {
  const secretKeys = new Set<string>(BUILTIN_CONFIG_SECRET_KEYS);
  for (const key of getConfigSchemaSecretKeys(channelId)) {
    secretKeys.add(key);
  }
  for (const fieldPath of existingRefPaths) {
    const key = configSecretFieldPathToKey(fieldPath);
    if (key) {
      secretKeys.add(key);
    }
  }
  return secretKeys;
}

export function getConfigSecretFieldPaths(
  channelId: string,
  existingRefPaths: Iterable<string> = [],
): string[] {
  return [...getConfigSecretKeys(channelId, existingRefPaths)].map(
    toConfigSecretFieldPath,
  );
}

export function getAccountSecretFieldPaths(account: ChannelAccount): string[] {
  const persistedRefPaths = getPersistedSecretRefPaths(account);
  if (isSlackChannelAccount(account)) {
    return [...new Set(["botToken", "appToken", ...persistedRefPaths])];
  }
  if (isTelegramChannelAccount(account) || isDiscordChannelAccount(account)) {
    return [...new Set(["token", ...persistedRefPaths])];
  }
  if (
    isCustomChannelAccount(account) ||
    !isFirstPartyChannelId(account.channel)
  ) {
    return [
      ...new Set([
        ...getConfigSecretFieldPaths(account.channel, persistedRefPaths),
        ...persistedRefPaths,
      ]),
    ];
  }
  return [...new Set(persistedRefPaths)];
}

export function mergeCredentialPatchValue(
  existingValue: string,
  patchValue: string | undefined,
): string {
  if (isNonEmptyString(patchValue)) {
    return patchValue;
  }
  return existingValue;
}

function missingCredentialMessage(
  channelId: "telegram" | "discord" | "slack",
  scope: MissingCredentialMessageScope,
): string {
  const subject = `Channel "${channelId}"${scope === "account" ? " account" : ""}`;
  if (channelId === "slack") {
    return `${subject} is missing a bot token or app token. Configure it first.`;
  }
  return `${subject} is missing a token. Configure it first.`;
}

export function getMissingRequiredCredentialMessageForAccount(
  account: ChannelAccount,
  options?: { scope?: MissingCredentialMessageScope },
): string | null {
  const scope = options?.scope ?? "account";
  if (isTelegramChannelAccount(account) && !isNonEmptyString(account.token)) {
    return missingCredentialMessage("telegram", scope);
  }
  if (isDiscordChannelAccount(account) && !isNonEmptyString(account.token)) {
    return missingCredentialMessage("discord", scope);
  }
  if (
    isSlackChannelAccount(account) &&
    (!isNonEmptyString(account.botToken) || !isNonEmptyString(account.appToken))
  ) {
    return missingCredentialMessage("slack", scope);
  }
  return null;
}

export function assertAccountHasRequiredCredentials(
  account: ChannelAccount,
  options?: { scope?: MissingCredentialMessageScope },
): void {
  const message = getMissingRequiredCredentialMessageForAccount(
    account,
    options,
  );
  if (message) {
    throw new Error(message);
  }
}

export function getMissingRequiredCredentialMessageForPatch(
  channelId: string,
  patch: Pick<ChannelAccountPatch, "token" | "botToken" | "appToken">,
  options?: { scope?: MissingCredentialMessageScope },
): string | null {
  const scope = options?.scope ?? "account";
  if (channelId === "telegram" && !isNonEmptyString(patch.token)) {
    return missingCredentialMessage("telegram", scope);
  }
  if (channelId === "discord" && !isNonEmptyString(patch.token)) {
    return missingCredentialMessage("discord", scope);
  }
  if (
    channelId === "slack" &&
    (!isNonEmptyString(patch.botToken) || !isNonEmptyString(patch.appToken))
  ) {
    return missingCredentialMessage("slack", scope);
  }
  return null;
}

export function assertEnabledAccountPatchHasRequiredCredentials(
  channelId: string,
  patch: ChannelAccountPatch,
): void {
  if (patch.enabled !== true) {
    return;
  }
  const message = getMissingRequiredCredentialMessageForPatch(channelId, patch);
  if (message) {
    throw new Error(message);
  }
}
