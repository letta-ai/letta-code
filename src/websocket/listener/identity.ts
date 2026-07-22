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
 *   Stable across restarts. Persisted per configuration key for manual
 *   listeners; supplied explicitly by the spawner for owned children
 *   (e.g. Desktop passes `LETTA_LISTENER_INSTANCE_ID=desktop-primary:<installation-id>`).
 * - Process instance: this exact OS process. Owned by the spawner's child
 *   registry (LET-10023), not by this module.
 * - Connection generation: one registration attempt; the relay's ephemeral
 *   `conn-*` id.
 *
 * The CONFIGURATION KEY for a manual listener is (project directory,
 * namespace, environment name): that triple names one configured listener,
 * and its minted identity is stable across restarts. The environment name
 * therefore participates in selecting WHICH configuration this is (renaming
 * configures a new listener whose old relay row ages out via lastSeenAt) —
 * but the identity VALUE is a random UUID, never derived from the name, so
 * same-named listeners in other projects/machines/processes can never
 * collide on a relay slot.
 *
 * Identity get-or-create is ATOMIC (O_EXCL + hard-link publication, one
 * file per configuration key under ~/.letta/listener-identities). Two
 * first-time processes racing the same configuration converge on one
 * identity — the loser of the publish race reads the winner's value — so
 * the single-run lock keyed by this identity actually guards them.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Environment variable a spawner sets to assign the child an explicit
 * listener identity. Takes precedence over the persisted per-configuration
 * identity. Desktop uses `desktop-<slot>:<installation-id>`.
 */
export const LISTENER_INSTANCE_ID_ENV = "LETTA_LISTENER_INSTANCE_ID";

/** Prefix for identities minted by this module for manual listeners. */
const MANUAL_INSTANCE_ID_PREFIX = "li";

const DEFAULT_IDENTITY_DIR = path.join(
  homedir(),
  ".letta",
  "listener-identities",
);

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
 * Which run mode configured this listener. `letta server` and the in-app
 * /listen command are distinct configured listeners even when they share a
 * project and display name; the namespace keeps their persisted identities
 * apart.
 */
export type ListenerIdentityNamespace = "server" | "listen";

export type ResolvedListenerIdentity = {
  listenerInstanceId: string;
  /**
   * Where the identity came from. "spawner" ids belong to an owning parent
   * process (Desktop); "persisted" and "minted" ids belong to a manual
   * listener configured on this machine.
   */
  source: "spawner" | "persisted" | "minted";
};

/**
 * True when this process is a Desktop-spawned listener child that was NOT
 * given an explicit identity (a Desktop build predating LET-10023).
 *
 * Such children must keep their legacy name-derived identities AND must
 * not participate in identity minting or the single-run lock: Desktop
 * legitimately runs multiple children that share a project and display
 * name, so minting per-configuration identities here would collide its
 * siblings on the lock — turning the old relay ping-pong into a local
 * startup failure. Their lifecycle belongs to Desktop; new Desktop builds
 * pass explicit per-slot identities and never hit this path.
 */
export function isLegacyDesktopSpawn(): boolean {
  if (process.env.LETTA_DESKTOP_MODE !== "1") {
    return false;
  }
  const explicit = process.env[LISTENER_INSTANCE_ID_ENV];
  return !(explicit && isValidListenerInstanceId(explicit));
}

function identityFilePath(
  identityDir: string,
  namespace: ListenerIdentityNamespace,
  connectionName: string,
  workingDirectory: string,
): string {
  const digest = createHash("sha256")
    .update(`${workingDirectory}\n${namespace}\n${connectionName}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(identityDir, `${digest}.json`);
}

function parseIdentityFile(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { listenerInstanceId?: unknown };
    return typeof parsed.listenerInstanceId === "string" &&
      isValidListenerInstanceId(parsed.listenerInstanceId)
      ? parsed.listenerInstanceId
      : null;
  } catch {
    return null;
  }
}

/**
 * Remove a corrupt identity file under a content-keyed repair claim.
 * The same generation guard as the stale-lock reclaim: publish a claim
 * keyed to the exact corrupt content, then re-verify the file still holds
 * that content before removing. Without it, two racers that both read the
 * corrupt file could interleave as A-removes/A-publishes-valid/
 * B-removes-A's-VALID-identity — splitting one configuration across two
 * identities (and therefore two different locks).
 *
 * Returns true when the corrupt generation is gone (removed by us or
 * already replaced) and the caller may retry; false when repair could not
 * proceed safely (contended claim) — the caller loops and re-reads.
 */
async function repairCorruptIdentity(
  identityPath: string,
  corruptRaw: string,
): Promise<boolean> {
  const claimPath = `${identityPath}.repair-${createHash("sha256")
    .update(corruptRaw)
    .digest("hex")
    .slice(0, 16)}`;
  const candidatePath = `${claimPath}.candidate-${randomUUID()}`;
  let claimed = false;
  try {
    await writeFile(candidatePath, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
    });
    await link(candidatePath, claimPath);
    claimed = true;
  } catch {
    // Another repairer owns this corrupt generation — let it finish.
    return false;
  } finally {
    await rm(candidatePath, { force: true }).catch(() => {});
  }

  try {
    let currentRaw: string;
    try {
      currentRaw = await readFile(identityPath, "utf-8");
    } catch {
      return true; // already gone
    }
    if (currentRaw !== corruptRaw) {
      return true; // replaced (possibly by a valid identity) — re-read
    }
    await rm(identityPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    if (claimed) {
      await rm(claimPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Atomic get-or-create of the persisted identity for one configuration
 * key. Publication is O_EXCL candidate + hard link: exactly one racer's
 * mint lands; everyone else reads the winner. Corrupt files are removed
 * only under a content-keyed repair claim (see repairCorruptIdentity).
 */
async function getOrCreatePersistedIdentity(
  identityPath: string,
  connectionName: string,
  namespace: ListenerIdentityNamespace,
  workingDirectory: string,
): Promise<ResolvedListenerIdentity> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw: string | null = null;
    try {
      raw = await readFile(identityPath, "utf-8");
    } catch {
      // Missing — mint below.
    }
    if (raw !== null) {
      const existing = parseIdentityFile(raw);
      if (existing) {
        return { listenerInstanceId: existing, source: "persisted" };
      }
      // Corrupt: repair under a claim, then loop to re-read (the repairer
      // that beat us may have republished a valid identity).
      await repairCorruptIdentity(identityPath, raw);
      continue;
    }

    const minted = `${MANUAL_INSTANCE_ID_PREFIX}-${randomUUID()}`;
    const candidatePath = `${identityPath}.candidate-${randomUUID()}`;
    try {
      await mkdir(path.dirname(identityPath), { recursive: true });
      await writeFile(
        candidatePath,
        JSON.stringify({
          listenerInstanceId: minted,
          namespace,
          connectionName,
          workingDirectory,
          mintedAt: Date.now(),
        }),
        { flag: "wx" },
      );
      await link(candidatePath, identityPath);
      return { listenerInstanceId: minted, source: "minted" };
    } catch {
      // Lost the publish race (EEXIST) or fs trouble — loop and re-read.
    } finally {
      await rm(candidatePath, { force: true }).catch(() => {});
    }
  }

  // Persistent store unusable: fall back to a session-scoped identity so
  // the listener still runs. It gets a fresh relay row per run (old rows
  // age out via lastSeenAt) — degraded but never colliding.
  return {
    listenerInstanceId: `${MANUAL_INSTANCE_ID_PREFIX}-${randomUUID()}`,
    source: "minted",
  };
}

/**
 * Resolve the stable identity for a listener session.
 *
 * Precedence:
 * 1. Spawner-provided env (owned children — Desktop slots).
 * 2. Identity persisted for this configuration key, created atomically on
 *    first use.
 */
export async function resolveListenerIdentity(
  connectionName: string,
  options: {
    namespace?: ListenerIdentityNamespace;
    workingDirectory?: string;
    identityDir?: string;
  } = {},
): Promise<ResolvedListenerIdentity> {
  const fromSpawner = process.env[LISTENER_INSTANCE_ID_ENV];
  if (fromSpawner && isValidListenerInstanceId(fromSpawner)) {
    return { listenerInstanceId: fromSpawner, source: "spawner" };
  }

  const namespace = options.namespace ?? "server";
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const identityDir = options.identityDir ?? DEFAULT_IDENTITY_DIR;
  return getOrCreatePersistedIdentity(
    identityFilePath(identityDir, namespace, connectionName, workingDirectory),
    connectionName,
    namespace,
    workingDirectory,
  );
}
