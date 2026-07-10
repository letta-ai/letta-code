/**
 * LidDesk — persistent PN↔LID mapping store for WhatsApp.
 *
 * Mines and caches phone-number (PN) ↔ linked-identity (LID) mappings so that
 * send/presence operations can resolve LID chatIds to phone JIDs across
 * container restarts. Mappings are persisted as plain JSON in the account auth
 * directory; they are invalidated implicitly on session logout (the file
 * remains but the mappings may become stale — a fresh pairing clears them).
 *
 * The desk is the single source of truth for PN↔LID. Adapter-local maps
 * (`lidToJid`, `jidToLid`) delegate to it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isLidJid, normalizeMaybePhoneJid, stripDeviceSuffix } from "./jid";

// ── Types ────────────────────────────────────────────────────────────

/**
 * A WhatsApp message key fragment — only the fields we mine.
 */
export type LidDeskMessageSource = {
  key?: {
    senderPn?: string | null;
    participant?: string | null;
    remoteJid?: string | null;
  } | null;
};

/**
 * Baileys socket shape — only the signal repository we read.
 */
export type LidDeskSocketSource = {
  signalRepository?:
    | {
        lidMapping?: Map<string, string> | undefined;
      }
    | undefined;
};

/**
 * Result entry from Baileys' `sock.onWhatsApp(phone)`.
 */
type OnWhatsAppResult = {
  exists?: boolean;
  jid?: string;
  lid?: string;
};

/**
 * Socket accessor for on-demand LID lookup via `sock.onWhatsApp`.
 * Only the methods we call.
 */
export type OnWhatsAppSocket = {
  onWhatsApp?: (
    phoneNumber: string,
  ) => Promise<OnWhatsAppResult[] | undefined | null>;
};

// ── Rate-limit config ────────────────────────────────────────────────

const DEFAULT_ON_WHATSAPP_MAX_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Serializable mapping record persisted to disk.
 */
type LidDeskData = {
  /** lid → phone JID */
  lidToJid: Record<string, string>;
  /** phone JID → lid */
  jidToLid: Record<string, string>;
};

// ── Module ────────────────────────────────────────────────────────────

const DESK_FILENAME = "lid-mappings.json";

export class LidDesk {
  private lidToJid = new Map<string, string>();
  private jidToLid = new Map<string, string>();
  private readonly filePath: string;
  private dirty = false;

  constructor(
    authDir: string,
    options?: { onWhatsAppMaxPerMinute?: number },
  ) {
    this.filePath = join(authDir, DESK_FILENAME);
    this.lookupMaxPerMinute =
      options?.onWhatsAppMaxPerMinute ?? DEFAULT_ON_WHATSAPP_MAX_PER_MINUTE;
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Load mappings from disk. No-op if the file doesn't exist yet.
   * Corrupt JSON is treated as empty (logged, not thrown).
   */
  load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as LidDeskData;
      if (data && typeof data === "object") {
        this.lidToJid = new Map(Object.entries(data.lidToJid ?? {}));
        this.jidToLid = new Map(Object.entries(data.jidToLid ?? {}));
      }
    } catch (err) {
      console.warn(
        `[LidDesk] Failed to load ${this.filePath}, starting empty:`,
        err instanceof Error ? err.message : err,
      );
      this.lidToJid.clear();
      this.jidToLid.clear();
    }
    this.dirty = false;
  }

  /**
   * Persist mappings to disk if dirty. Creates parent dir if needed.
   * Errors are logged, not thrown — persistence is best-effort.
   */
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: LidDeskData = {
        lidToJid: Object.fromEntries(this.lidToJid),
        jidToLid: Object.fromEntries(this.jidToLid),
      };
      writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
      this.dirty = false;
    } catch (err) {
      console.warn(
        `[LidDesk] Failed to save ${this.filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Look up the phone JID for a LID. Returns null if unknown. */
  resolveLid(lidJid: string): string | null {
    const normalized = stripDeviceSuffix(lidJid);
    const pn = this.lidToJid.get(normalized);
    return normalizeMaybePhoneJid(pn) ?? null;
  }

  /** Look up the LID for a phone JID. Returns null if unknown. */
  resolvePn(phoneJid: string): string | null {
    const normalized = stripDeviceSuffix(phoneJid);
    const lid = this.jidToLid.get(normalized);
    return lid ? stripDeviceSuffix(lid) : null;
  }

  /** Expose a snapshot of lid→jid for interop with resolveSendJid callers. */
  getLidToJidMap(): Map<string, string> {
    return new Map(this.lidToJid);
  }

  /** Expose a snapshot of jid→lid for interop with resolvePresenceJid callers. */
  getJidToLidMap(): Map<string, string> {
    return new Map(this.jidToLid);
  }

  // ── Mining ─────────────────────────────────────────────────────────

  /**
   * Record a PN↔LID mapping. Both directions are stored.
   * Values are normalized (device suffix stripped, phone-JID validated).
   * Returns true if the mapping was new or changed.
   */
  record(lidJid: string, phoneJid: string): boolean {
    const lid = stripDeviceSuffix(lidJid);
    const pn = normalizeMaybePhoneJid(phoneJid);
    if (!lid || !pn || !isLidJid(lid)) return false;

    const existing = this.lidToJid.get(lid);
    if (existing === pn) return false;

    this.lidToJid.set(lid, pn);
    this.jidToLid.set(pn, lid);
    this.dirty = true;
    return true;
  }

  /**
   * Mine a PN↔LID mapping from an inbound message.
   *
   * Sources checked (in priority order):
   * 1. `msg.key.senderPn` paired with `msg.key.remoteJid` (when remoteJid is a LID)
   * 2. `msg.key.participant` paired with `msg.key.remoteJid` (group: participant may carry LID or PN)
   *
   * Returns true if any new mapping was recorded.
   */
  mineFromMessage(msg: LidDeskMessageSource): boolean {
    let changed = false;
    const key = msg?.key;
    if (!key) return false;

    const remoteJid = key.remoteJid ?? null;
    const senderPn = key.senderPn ?? null;
    const participant = key.participant ?? null;

    // Source 1: remoteJid is a LID and senderPn is a phone JID
    if (remoteJid && isLidJid(remoteJid) && senderPn) {
      const pn = normalizeMaybePhoneJid(senderPn);
      if (pn) {
        changed = this.record(remoteJid, pn) || changed;
      }
    }

    // Source 2: participant is a LID and senderPn provides the phone number
    if (participant && isLidJid(participant) && senderPn) {
      const pn = normalizeMaybePhoneJid(senderPn);
      if (pn) {
        changed = this.record(participant, pn) || changed;
      }
    }

    // Source 3: remoteJid is a LID and participant is a phone JID
    // (happens in some group contexts where remoteJid is the LID-routed chat
    // but participant carries the phone JID)
    if (remoteJid && isLidJid(remoteJid) && participant) {
      const pn = normalizeMaybePhoneJid(participant);
      if (pn) {
        changed = this.record(remoteJid, pn) || changed;
      }
    }

    return changed;
  }

  /**
   * Mine all mappings from the Baileys signalRepository.lidMapping Map.
   * This is a read-only operation on the socket.
   *
   * Returns the number of new/changed mappings recorded.
   */
  mineFromSocket(sock: LidDeskSocketSource | null | undefined): number {
    const lidMapping = sock?.signalRepository?.lidMapping;
    if (!lidMapping || typeof lidMapping.get !== "function") return 0;

    let count = 0;
    for (const [lid, pn] of lidMapping) {
      if (this.record(lid, pn)) count += 1;
    }
    return count;
  }

  // ── On-demand LID lookup ──────────────────────────────────────────

  /**
   * Rate-limit state for `lookupLidForPhone`.
   * Tracks timestamps of recent calls per normalized phone JID.
   */
  private lookupTimestamps = new Map<string, number[]>();
  private readonly lookupMaxPerMinute: number;

  /**
   * Look up a LID for a phone JID on demand via Baileys' `sock.onWhatsApp`.
   *
   * Flow:
   * 1. Cache check — return known LID from `jidToLid` if present.
   * 2. If unknown and a socket accessor is provided, call `sock.onWhatsApp(phoneJid)`.
   * 3. If the response has `exists: true` and a `lid`, persist `{ lid, phoneJid }` to the desk.
   * 4. If lookup fails (no socket, throttle, exception, number not on WhatsApp),
   *    return null — caller falls back to current behavior.
   *
   * Rate-limited to at most `lookupMaxPerMinute` calls per phone per minute.
   */
  async lookupLidForPhone(
    phoneJid: string,
    sock?: OnWhatsAppSocket | null,
  ): Promise<string | null> {
    // 1. Cache check
    const normalized = stripDeviceSuffix(phoneJid);
    const cached = this.jidToLid.get(normalized);
    if (cached) return cached;

    // 2. No socket → cannot look up
    if (!sock?.onWhatsApp) return null;

    // 3. Rate-limit check — at most N calls per phone per minute
    if (!this.canLookup(normalized)) {
      console.warn(
        `[LidDesk] Rate-limit: skipping onWhatsApp for ${normalized} (max ${this.lookupMaxPerMinute}/min)`,
      );
      return null;
    }

    // 4. Call onWhatsApp
    try {
      const results = await sock.onWhatsApp(normalized);
      const entry = Array.isArray(results) ? results[0] : undefined;
      if (!entry?.exists || !entry.lid) {
        // Number not on WhatsApp, or no LID available — do NOT write a mapping.
        return null;
      }

      const lidJid = stripDeviceSuffix(entry.lid);
      if (!lidJid || !isLidJid(lidJid)) return null;

      // 5. Persist mapping (same shape as record())
      this.record(lidJid, normalized);
      this.save();
      return lidJid;
    } catch (err) {
      console.warn(
        `[LidDesk] onWhatsApp lookup failed for ${normalized}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Check if a phone JID can be looked up right now without exceeding
   * the rate limit. Prunes stale entries as a side effect.
   */
  private canLookup(normalizedPhone: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const timestamps = this.lookupTimestamps.get(normalizedPhone);

    if (timestamps) {
      // Prune entries older than the window
      const recent = timestamps.filter((t) => t > cutoff);
      if (recent.length >= this.lookupMaxPerMinute) {
        this.lookupTimestamps.set(normalizedPhone, recent);
        return false;
      }
      recent.push(now);
      this.lookupTimestamps.set(normalizedPhone, recent);
    } else {
      this.lookupTimestamps.set(normalizedPhone, [now]);
    }
    return true;
  }

  // ── Misc ───────────────────────────────────────────────────────────

  /** Number of mappings currently stored. */
  get size(): number {
    return this.lidToJid.size;
  }

  /** Clear all mappings (used on logout / fresh pairing). */
  clear(): void {
    if (this.lidToJid.size === 0 && this.jidToLid.size === 0) return;
    this.lidToJid.clear();
    this.jidToLid.clear();
    this.dirty = true;
  }
}
