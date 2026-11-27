import { markManagedCloudRuntimeFromListenerIdentity } from "@/managed-cloud-runtime";

export const LISTENER_INSTANCE_ID_ENV = "LETTA_LISTENER_INSTANCE_ID";

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function isValidListenerInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value);
}

let activeListener: { connectionName: string | null } | null = null;

export function setActiveListenerIdentity(
  listener: { connectionName: string | null } | null,
): void {
  activeListener = listener;
}

export function getActiveListenerConnectionName(): string | null {
  return activeListener?.connectionName ?? null;
}

let cachedSpawnerListenerInstanceId: string | null | undefined;
let cachedSpawnerDeviceId: string | null | undefined;

export function getSpawnerDeviceId(): string | null {
  if (cachedSpawnerDeviceId !== undefined) return cachedSpawnerDeviceId;
  const value = process.env.LETTA_LISTENER_DEVICE_ID;
  delete process.env.LETTA_LISTENER_DEVICE_ID;
  if (value && !isValidListenerInstanceId(value)) {
    throw new Error("Invalid spawner device ID");
  }
  cachedSpawnerDeviceId = value || null;
  return cachedSpawnerDeviceId;
}

export function getSpawnerListenerInstanceId(): string | null {
  if (cachedSpawnerListenerInstanceId !== undefined) {
    return cachedSpawnerListenerInstanceId;
  }

  const value = process.env[LISTENER_INSTANCE_ID_ENV];
  delete process.env[LISTENER_INSTANCE_ID_ENV];
  cachedSpawnerListenerInstanceId =
    value && isValidListenerInstanceId(value) ? value : null;
  if (cachedSpawnerListenerInstanceId) {
    markManagedCloudRuntimeFromListenerIdentity(
      cachedSpawnerListenerInstanceId,
    );
  }
  return cachedSpawnerListenerInstanceId;
}

export const __listenerIdentityTestUtils = {
  resetCachedSpawnerIdentity() {
    cachedSpawnerListenerInstanceId = undefined;
    cachedSpawnerDeviceId = undefined;
  },
};
