import { settingsManager } from "@/settings-manager";
import {
  deleteSecretValue,
  getSecretValue,
  isKeychainAvailable,
  setSecretValue,
} from "@/utils/secrets";

export type ChannelCredentialsStoreMode = "file" | "keyring" | "auto";
export type ActiveChannelCredentialsStoreMode = "file" | "keyring";

const CHANNEL_CREDENTIALS_STORE_ENV = "LETTA_CHANNEL_CREDENTIALS_STORE";
const CHANNEL_SECRET_PREFIX = "channel";

let activeModeCache: ActiveChannelCredentialsStoreMode | null = null;
let requestedModeOverrideForTests: ChannelCredentialsStoreMode | null = null;
let activeModeOverrideForTests: ActiveChannelCredentialsStoreMode | null = null;
let keychainAvailableOverrideForTests: boolean | null = null;
let channelSecretStoreOverrideForTests: {
  get: (name: string) => Promise<string | null>;
  set: (name: string, value: string) => Promise<void>;
  delete: (name: string) => Promise<boolean>;
} | null = null;

function parseStoreMode(value: unknown): ChannelCredentialsStoreMode | null {
  return value === "file" || value === "keyring" || value === "auto"
    ? value
    : null;
}

export function getRequestedChannelCredentialsStoreMode(): ChannelCredentialsStoreMode {
  if (requestedModeOverrideForTests) {
    return requestedModeOverrideForTests;
  }

  const envMode = parseStoreMode(process.env[CHANNEL_CREDENTIALS_STORE_ENV]);
  if (envMode) {
    return envMode;
  }

  try {
    return (
      parseStoreMode(settingsManager.getSettings().channelCredentialsStore) ??
      "auto"
    );
  } catch {
    return "auto";
  }
}

export async function getActiveChannelCredentialsStoreMode(): Promise<ActiveChannelCredentialsStoreMode> {
  if (activeModeOverrideForTests) {
    activeModeCache = activeModeOverrideForTests;
    return activeModeOverrideForTests;
  }

  if (activeModeCache) {
    return activeModeCache;
  }

  const requestedMode = getRequestedChannelCredentialsStoreMode();
  if (requestedMode === "file") {
    activeModeCache = "file";
    return activeModeCache;
  }

  const keychainAvailable =
    keychainAvailableOverrideForTests ?? (await isKeychainAvailable());
  if (keychainAvailable) {
    activeModeCache = "keyring";
    return activeModeCache;
  }

  if (requestedMode === "keyring") {
    throw new Error(
      "Channel credential store is set to keyring, but OS secure storage is unavailable.",
    );
  }

  activeModeCache = "file";
  return activeModeCache;
}

export function getCachedChannelCredentialsStoreMode(): ActiveChannelCredentialsStoreMode | null {
  return activeModeCache;
}

export function buildChannelSecretName(
  channelId: string,
  accountId: string,
  field: string,
): string {
  return [CHANNEL_SECRET_PREFIX, channelId, accountId, field].join(":");
}

export async function getChannelSecret(
  channelId: string,
  accountId: string,
  field: string,
): Promise<string | null> {
  const name = buildChannelSecretName(channelId, accountId, field);
  if (channelSecretStoreOverrideForTests) {
    return channelSecretStoreOverrideForTests.get(name);
  }

  return getSecretValue(name, `${channelId}/${accountId}/${field}`);
}

export async function setChannelSecret(
  channelId: string,
  accountId: string,
  field: string,
  value: string,
): Promise<void> {
  const name = buildChannelSecretName(channelId, accountId, field);
  if (channelSecretStoreOverrideForTests) {
    await channelSecretStoreOverrideForTests.set(name, value);
    return;
  }

  await setSecretValue(name, value);
}

export async function deleteChannelSecret(
  channelId: string,
  accountId: string,
  field: string,
): Promise<boolean> {
  const name = buildChannelSecretName(channelId, accountId, field);
  if (channelSecretStoreOverrideForTests) {
    return channelSecretStoreOverrideForTests.delete(name);
  }

  return deleteSecretValue(name);
}

export function __setChannelCredentialsStoreModeForTests(
  mode: ChannelCredentialsStoreMode | null,
): void {
  requestedModeOverrideForTests = mode;
  activeModeCache = null;
}

export function __resetChannelCredentialsStoreModeCacheForTests(): void {
  activeModeCache = null;
}

export function __setActiveChannelCredentialsStoreModeForTests(
  mode: ActiveChannelCredentialsStoreMode | null,
): void {
  activeModeOverrideForTests = mode;
  activeModeCache = null;
}

export function __setChannelKeychainAvailableForTests(
  available: boolean | null,
): void {
  keychainAvailableOverrideForTests = available;
  activeModeCache = null;
}

export function __setChannelSecretStoreOverrideForTests(
  override: typeof channelSecretStoreOverrideForTests,
): void {
  channelSecretStoreOverrideForTests = override;
}
