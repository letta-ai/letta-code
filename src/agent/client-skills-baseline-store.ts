/**
 * On-disk store for per-conversation `client_skills` baselines.
 *
 * Each conversation scope gets one small JSON file under the server-scoped
 * state directory used by other durable harness state:
 *
 *   <config-dir>/state/<backend-namespace>/client-skills-baselines/<scope>.json
 *
 * The namespace is a hash of the backend identity (API server URL, or the
 * local backend's storage dir), so baselines from different servers or
 * backends never mix. Every operation is best-effort: a missing, corrupt, or
 * unreadable file loads as "no baseline", and a failed write is swallowed so
 * it can never fail a send.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import { APIBackend } from "@/backend/backend";
import { renameSyncWithRetry } from "@/utils/rename-sync-with-retry";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import type { ClientSkill } from "./client-skills";

export type PersistedClientSkillsBaseline = {
  frozen: ClientSkill[];
  announced: ClientSkill[];
  rebaseline: boolean;
};

type BaselineFile = PersistedClientSkillsBaseline & {
  version: 1;
  scope: string;
  updatedAtMs: number;
};

/** Files untouched for this long describe conversations nobody resumes. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on files kept per backend namespace (oldest pruned first). */
const MAX_FILES_PER_NAMESPACE = 500;

type StoreConfig = {
  /** Root replacing `<config-dir>/state`; null disables persistence. */
  rootDir: string | null;
  /** Backend identity override; null means "not persistable". */
  identify?: (backend: object) => string | null;
};

let configOverride: StoreConfig | undefined;
/** Writes per namespace since its last prune; prune on first and every Nth. */
const writesSincePrune = new Map<string, number>();
const PRUNE_EVERY_WRITES = 100;

/** Test-only: redirect (or disable with `null`) baseline persistence. */
export function configureClientSkillsBaselineStoreForTests(
  config: StoreConfig | undefined,
): void {
  configOverride = config;
  writesSincePrune.clear();
}

function stateRoot(): string | null {
  if (configOverride !== undefined) return configOverride.rootDir;
  if (process.env.NODE_ENV === "test") return null;
  return join(resolveGlobalConfigDir(), "state");
}

/**
 * Stable identity of the server or store behind `backend`, or null when the
 * backend has no durable identity (in-memory dev backends, test fakes).
 */
export function clientSkillsBackendIdentity(backend: object): string | null {
  if (configOverride?.identify) return configOverride.identify(backend);
  const localStorageDir = (
    backend as { getLocalStorageDir?: () => unknown }
  ).getLocalStorageDir?.();
  if (typeof localStorageDir === "string") return `local:${localStorageDir}`;
  if (backend instanceof APIBackend) {
    try {
      return getServerUrl();
    } catch {
      return process.env.LETTA_BASE_URL ?? null;
    }
  }
  return null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function namespaceDir(backend: object): string | null {
  const root = stateRoot();
  if (!root) return null;
  const identity = clientSkillsBackendIdentity(backend);
  if (!identity) return null;
  // API identities hash the bare server URL, matching the namespace other
  // server-scoped state already uses under `state/`.
  return join(root, shortHash(identity), "client-skills-baselines");
}

function isClientSkillList(value: unknown): value is ClientSkill[] {
  return (
    Array.isArray(value) &&
    value.every(
      (skill) =>
        typeof skill === "object" &&
        skill !== null &&
        typeof (skill as ClientSkill).name === "string" &&
        typeof (skill as ClientSkill).description === "string" &&
        typeof (skill as ClientSkill).location === "string",
    )
  );
}

function parseBaselineFile(
  raw: string,
  scope: string,
): PersistedClientSkillsBaseline | null {
  const parsed = JSON.parse(raw) as Partial<BaselineFile> | null;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.version !== 1 ||
    // Guards against a hash collision or a hand-copied file.
    parsed.scope !== scope ||
    !isClientSkillList(parsed.frozen) ||
    !isClientSkillList(parsed.announced) ||
    typeof parsed.rebaseline !== "boolean"
  ) {
    return null;
  }
  return {
    frozen: parsed.frozen,
    announced: parsed.announced,
    rebaseline: parsed.rebaseline,
  };
}

export function loadClientSkillsBaseline(
  backend: object,
  scope: string,
): PersistedClientSkillsBaseline | null {
  try {
    const dir = namespaceDir(backend);
    if (!dir) return null;
    return parseBaselineFile(
      readFileSync(join(dir, `${shortHash(scope)}.json`), "utf8"),
      scope,
    );
  } catch {
    // Missing or corrupt: fall back to a fresh baseline.
    return null;
  }
}

export function saveClientSkillsBaseline(
  backend: object,
  scope: string,
  baseline: PersistedClientSkillsBaseline,
): void {
  let tmp: string | null = null;
  try {
    const dir = namespaceDir(backend);
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file: BaselineFile = {
      version: 1,
      scope,
      frozen: baseline.frozen,
      announced: baseline.announced,
      rebaseline: baseline.rebaseline,
      updatedAtMs: Date.now(),
    };
    const destination = join(dir, `${shortHash(scope)}.json`);
    tmp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
    renameSyncWithRetry(tmp, destination);
    tmp = null;
    const writes = writesSincePrune.get(dir);
    if (writes === undefined || writes >= PRUNE_EVERY_WRITES) {
      writesSincePrune.set(dir, 1);
      pruneBaselineFiles(dir, Date.now());
    } else {
      writesSincePrune.set(dir, writes + 1);
    }
  } catch {
    // Best-effort: the in-memory baseline still applies to this process.
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
}

/**
 * Remove stale baselines and leftover temp files, then cap the namespace at
 * MAX_FILES_PER_NAMESPACE by dropping the least recently written files.
 * Runs on a namespace's first write in a process and periodically after.
 */
export function pruneBaselineFiles(dir: string, nowMs: number): void {
  const live: { path: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const { mtimeMs } = statSync(path);
      if (!name.endsWith(".json") || nowMs - mtimeMs > STALE_AFTER_MS) {
        // Temp files younger than a minute may belong to a concurrent writer.
        if (name.endsWith(".json") || nowMs - mtimeMs > 60_000) {
          unlinkSync(path);
        }
        continue;
      }
      live.push({ path, mtimeMs });
    } catch {}
  }
  if (live.length <= MAX_FILES_PER_NAMESPACE) return;
  live.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { path } of live.slice(0, live.length - MAX_FILES_PER_NAMESPACE)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
