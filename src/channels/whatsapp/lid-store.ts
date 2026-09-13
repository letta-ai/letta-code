/**
 * Narrow persistent store: LID JID → phone JID.
 *
 * Invariants:
 *   - Only strict-valid LID keys and strict-valid phone-JID values are accepted.
 *   - Device suffixes are normalised on both keys and values.
 *   - An existing mapping is never silently rebound. A conflicting `record()`
 *     returns `{ status: "conflict" }` and preserves the old mapping.
 *   - Multiple distinct LIDs may map to the same phone JID.
 *   - Corrupt or invalid persisted entries are silently skipped.
 *   - On load, if the same normalized LID appears with different phone JIDs,
 *     that LID is omitted entirely (ambiguous data, not first-wins).
 *
 * Persistence:
 *   - Construction loads once from disk. There is no public reload.
 *   - `record()` mutates in-memory state only; it does NOT persist.
 *   - `flush()` is caller-owned and writes atomically via an exclusive temp
 *     file + rename. The caller is responsible for single-writer ownership;
 *     no locking is provided.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

import {
  isStrictLidJid,
  isStrictPhoneJid,
  stripDeviceSuffix,
} from "@/channels/whatsapp/jid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordResult =
  | { status: "recorded" }
  | { status: "idempotent" }
  | { status: "conflict"; existingPhoneJid: string; requestedPhoneJid: string };

export interface LidStore {
  /** Resolve a LID JID to its canonical phone JID, or `null` if unknown. */
  resolve(lidJid: string): string | null;
  /**
   * Record a LID → phone mapping (in-memory only; does not persist).
   *
   * Returns `null` when either argument is invalid.
   * Returns `"conflict"` when the LID is already mapped to a different phone;
   * the old mapping is preserved.
   */
  record(lidJid: string, phoneJid: string): RecordResult | null;
  /** Flush in-memory state to disk atomically. Caller-owned, single-writer. */
  flush(): void;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

type StoreEntry = { lid: string; phone: string };

function parseStoreFile(filePath: string): Map<string, string> {
  let rawText: string;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return new Map();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }

  const obj = parsed as { entries?: unknown };
  if (!Array.isArray(obj.entries)) return new Map();

  // First pass: collect all normalized pairs per LID key.
  const collected = new Map<string, Set<string>>();
  for (const entry of obj.entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { lid?: unknown; phone?: unknown };
    if (
      typeof e.lid !== "string" ||
      typeof e.phone !== "string" ||
      !isStrictLidJid(e.lid) ||
      !isStrictPhoneJid(e.phone)
    ) {
      continue;
    }
    const key = stripDeviceSuffix(e.lid);
    const value = stripDeviceSuffix(e.phone);
    let phoneSet = collected.get(key);
    if (!phoneSet) {
      phoneSet = new Set<string>();
      collected.set(key, phoneSet);
    }
    phoneSet.add(value);
  }

  // Second pass: keep only unambiguous LIDs (exactly one phone mapping).
  const result = new Map<string, string>();
  for (const [key, phones] of collected) {
    if (phones.size === 1) {
      result.set(key, phones.values().next().value as string);
    }
  }
  return result;
}

function serializeStore(map: Map<string, string>): string {
  const entries: StoreEntry[] = [];
  for (const [lid, phone] of map) {
    entries.push({ lid, phone });
  }
  return JSON.stringify({ entries }, null, 2);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLidStore(filePath: string): LidStore {
  if (!isAbsolute(filePath)) {
    throw new Error(
      `createLidStore requires an absolute path, got: ${filePath}`,
    );
  }

  const map = parseStoreFile(filePath);

  return {
    resolve(lidJid: string): string | null {
      if (!isStrictLidJid(lidJid)) return null;
      return map.get(stripDeviceSuffix(lidJid)) ?? null;
    },

    record(lidJid: string, phoneJid: string): RecordResult | null {
      if (!isStrictLidJid(lidJid)) return null;
      if (!isStrictPhoneJid(phoneJid)) return null;

      const key = stripDeviceSuffix(lidJid);
      const value = stripDeviceSuffix(phoneJid);

      const existing = map.get(key);
      if (existing) {
        if (existing === value) return { status: "idempotent" };
        return {
          status: "conflict",
          existingPhoneJid: existing,
          requestedPhoneJid: value,
        };
      }

      map.set(key, value);
      return { status: "recorded" };
    },

    flush(): void {
      const data = serializeStore(map);
      const dir = dirname(filePath);
      mkdirSync(dir, { recursive: true });

      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      let fd: number | null = null;
      try {
        fd = openSync(tmpPath, "wx", 0o600);
        writeFileSync(fd, data, "utf8");
        closeSync(fd);
        fd = null;
        renameSync(tmpPath, filePath);
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // already closed or error during close
          }
        }
        try {
          unlinkSync(tmpPath);
        } catch {
          // temp file may not exist after successful rename
        }
      }
    },
  };
}
