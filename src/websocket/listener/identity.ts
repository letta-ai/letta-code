import { markManagedCloudRuntimeFromListenerIdentity } from "@/managed-cloud-runtime";

/**
 * Environment variable an owning spawner sets to assign its child an
 * explicit listener identity. Desktop uses `desktop-<slot>:<installation-id>`.
 */
export const LISTENER_INSTANCE_ID_ENV = "LETTA_LISTENER_INSTANCE_ID";

/**
 * Instance ids must be compact and relay-safe. Spawner-provided ids are
 * validated rather than trusted blindly so a corrupted env var cannot
 * produce unbounded or unprintable slot keys server-side.
 */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function isValidListenerInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value);
}

/**
 * `undefined` means the startup environment has not been consumed yet.
 * After the first read, both a valid identity and the absence of one are
 * cached for the lifetime of this listener process.
 */
let cachedSpawnerListenerInstanceId: string | null | undefined;
let cachedSpawnerDeviceId: string | null | undefined;

/** Registration identity is owned by the spawner, not the shared CLI settings. */
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

/**
 * The spawner-assigned identity for THIS process, or null when none was
 * provided (ordinary manual listeners — legacy name-derived identity
 * applies).
 *
 * Consume exactly once, then delete the transport variable from process.env.
 * Registration and re-registration use the cache; Bash, subagents, and any
 * nested `letta server` processes inherit the sanitized environment and
 * therefore cannot impersonate the owning listener process's relay slot.
 */
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
