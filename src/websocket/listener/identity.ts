/**
 * Explicit local listener identity (LET-10085).
 *
 * A listener's identity must never be derived from its display name.
 * Deriving `listenerInstanceId` from (surface, connectionName) collapsed
 * distinct processes that legitimately share a display name — a
 * Desktop-spawned cloud listener and a manual `letta server`, both
 * defaulting to hostname() — onto one relay environment slot. The two then
 * rotated each other's connection lease: the displaced one received 1008,
 * re-registered, stole the lease back, and every steal aborted the current
 * holder's in-flight turn (LET-9772).
 *
 * Three identities, kept separate:
 * - Listener instance (this module): WHICH configured listener this is.
 *   Stable across restarts. Persisted per (project, environment name) for
 *   manual listeners; supplied explicitly by the spawner for owned children
 *   (e.g. Desktop passes `LETTA_LISTENER_INSTANCE_ID=desktop-primary:<installation-id>`).
 * - Process instance: this exact OS process. Owned by the spawner's child
 *   registry (LET-10023), not by this module.
 * - Connection generation: one registration attempt; the relay's ephemeral
 *   `conn-*` id.
 *
 * The display name (`connectionName`) is exactly that — a display name.
 * Renaming a listener does not change its identity; two listeners may share
 * a name and coexist.
 */

import { randomUUID } from "node:crypto";
import { settingsManager } from "@/settings-manager";

/**
 * Environment variable a spawner sets to assign the child an explicit
 * listener identity. Takes precedence over the persisted per-project
 * identity. Desktop uses `desktop-<slot>:<installation-id>`.
 */
export const LISTENER_INSTANCE_ID_ENV = "LETTA_LISTENER_INSTANCE_ID";

/** Prefix for identities minted by this module for manual listeners. */
const MANUAL_INSTANCE_ID_PREFIX = "li";

/**
 * Instance ids must be compact and relay-safe. Spawner-provided ids are
 * validated rather than trusted blindly so a corrupted env var cannot
 * produce unbounded or unprintable slot keys server-side.
 */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function isValidListenerInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value);
}

function mintManualListenerInstanceId(): string {
  return `${MANUAL_INSTANCE_ID_PREFIX}-${randomUUID()}`;
}

export type ResolvedListenerIdentity = {
  listenerInstanceId: string;
  /**
   * Where the identity came from. "spawner" ids belong to an owning parent
   * process (Desktop); "persisted" and "minted" ids belong to a manual
   * listener configured in this project.
   */
  source: "spawner" | "persisted" | "minted";
};

/**
 * Which run mode configured this listener. `letta server` and the in-app
 * /listen command are distinct configured listeners even when they share a
 * project and display name (they were previously separated by surface
 * prefix); the namespace keeps their persisted identities apart.
 */
export type ListenerIdentityNamespace = "server" | "listen";

/**
 * Resolve the stable identity for a listener session.
 *
 * Precedence:
 * 1. Spawner-provided env (owned children — Desktop slots).
 * 2. Identity previously persisted for this (project, namespace, env name).
 * 3. Freshly minted UUID identity, persisted for future runs.
 *
 * The persisted map is keyed by (namespace, environment name) so a project
 * that runs multiple named manual listeners keeps a distinct stable
 * identity per name, while renames mint a new identity (the old row ages
 * out server-side via lastSeenAt — same lifecycle as before, without the
 * name collision).
 */
export function resolveListenerIdentity(
  connectionName: string,
  options: {
    namespace?: ListenerIdentityNamespace;
    workingDirectory?: string;
  } = {},
): ResolvedListenerIdentity {
  const namespace = options.namespace ?? "server";
  const workingDirectory = options.workingDirectory ?? process.cwd();

  const fromSpawner = process.env[LISTENER_INSTANCE_ID_ENV];
  if (fromSpawner && isValidListenerInstanceId(fromSpawner)) {
    return { listenerInstanceId: fromSpawner, source: "spawner" };
  }

  const settingsKey = `${namespace}:${connectionName}`;
  const persisted = settingsManager.getListenerInstanceId(
    settingsKey,
    workingDirectory,
  );
  if (persisted && isValidListenerInstanceId(persisted)) {
    return { listenerInstanceId: persisted, source: "persisted" };
  }

  const minted = mintManualListenerInstanceId();
  settingsManager.setListenerInstanceId(settingsKey, minted, workingDirectory);
  return { listenerInstanceId: minted, source: "minted" };
}
