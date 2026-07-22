/**
 * Spawner-assigned listener identity (LET-10085, minimal scope).
 *
 * The one bug this solves: listener identity was derived from the display
 * name (`listenerInstanceId = <surface>-sha256(connectionName)`), so a
 * Desktop-spawned listener and a manual `letta server` — both defaulting
 * to hostname() as the name — collapsed onto one relay environment slot
 * and rotated each other's connection lease (the LET-9772 ping-pong that
 * aborted in-flight turns).
 *
 * The fix: an OWNING SPAWNER (Desktop, LET-10023) assigns its child an
 * explicit identity via LETTA_LISTENER_INSTANCE_ID (e.g.
 * `desktop-primary:<installation-id>`). Registration passes it through
 * verbatim, giving Desktop children relay slots that can never collide
 * with manual listeners or other installations.
 *
 * Manual listener identity behavior remains unchanged (legacy name-derived
 * ids). Standalone `letta server`/`letta remote` processes use that exact id
 * for their local single-instance guard; in-app `/listen` remains a separate
 * surface and is not part of that guard.
 */

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
 * The spawner-assigned identity for this process, or null when none was
 * provided (ordinary manual listeners — legacy name-derived identity
 * applies).
 */
export function getSpawnerListenerInstanceId(): string | null {
  const value = process.env[LISTENER_INSTANCE_ID_ENV];
  return value && isValidListenerInstanceId(value) ? value : null;
}
