/**
 * Per-account state persistence for the Bluesky plugin.
 *
 * Stored at ~/.letta/channels/bluesky/state.json (mode 0o600) so we
 * can cache the JWT session and the notifications cursor across
 * restarts and avoid re-authenticating on every boot.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getChannelDir } from "../config";
import {
  SEEN_NOTIFICATION_IDS_MAX,
  STATE_FILENAME,
  STATE_VERSION,
} from "./constants";
import type { BlueskySession } from "./types";

export interface BlueskyAccountState {
  /** AppView notifications cursor (opaque server token). */
  notificationsCursor?: string;
  /** Live auth session — access + refresh JWTs. */
  auth?: BlueskySession;
  /** Bounded LRU of post URIs we've already delivered, for replay safety. */
  seenNotificationUris: string[];
  /** ISO timestamp of the last successful poll. */
  lastPolledAt?: string;
}

interface BlueskyStateFile {
  version: number;
  updatedAt: string;
  accounts: Record<string, BlueskyAccountState>;
}

function makeDefaultState(): BlueskyStateFile {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    accounts: {},
  };
}

function getStatePath(): string {
  return join(getChannelDir("bluesky"), STATE_FILENAME);
}

function parseState(raw: string): BlueskyStateFile {
  try {
    const parsed = JSON.parse(raw) as Partial<BlueskyStateFile>;
    if (!parsed || typeof parsed !== "object") return makeDefaultState();
    const accounts: Record<string, BlueskyAccountState> = {};
    for (const [accountId, value] of Object.entries(parsed.accounts ?? {})) {
      if (!value || typeof value !== "object") continue;
      const seen = Array.isArray(value.seenNotificationUris)
        ? value.seenNotificationUris.filter(
            (uri): uri is string => typeof uri === "string",
          )
        : [];
      accounts[accountId] = {
        notificationsCursor:
          typeof value.notificationsCursor === "string"
            ? value.notificationsCursor
            : undefined,
        auth: isValidSession(value.auth) ? value.auth : undefined,
        seenNotificationUris: seen.slice(-SEEN_NOTIFICATION_IDS_MAX),
        lastPolledAt:
          typeof value.lastPolledAt === "string"
            ? value.lastPolledAt
            : undefined,
      };
    }
    return {
      version: STATE_VERSION,
      updatedAt: new Date().toISOString(),
      accounts,
    };
  } catch {
    return makeDefaultState();
  }
}

function isValidSession(value: unknown): value is BlueskySession {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<BlueskySession>;
  return (
    typeof s.did === "string" &&
    typeof s.accessJwt === "string" &&
    typeof s.refreshJwt === "string"
  );
}

export function loadBlueskyState(): BlueskyStateFile {
  const path = getStatePath();
  if (!existsSync(path)) return makeDefaultState();
  try {
    const text = readFileSync(path, "utf-8");
    return parseState(text);
  } catch {
    return makeDefaultState();
  }
}

export function saveBlueskyState(state: BlueskyStateFile): void {
  const dir = getChannelDir("bluesky");
  mkdirSync(dir, { recursive: true });
  const path = getStatePath();
  const payload: BlueskyStateFile = {
    ...state,
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX filesystems */
  }
}

export function getAccountState(
  state: BlueskyStateFile,
  accountId: string,
): BlueskyAccountState {
  const existing = state.accounts[accountId];
  if (existing) return existing;
  const created: BlueskyAccountState = {
    seenNotificationUris: [],
  };
  state.accounts[accountId] = created;
  return created;
}

export function updateAccountState(
  state: BlueskyStateFile,
  accountId: string,
  mutate: (current: BlueskyAccountState) => void,
): void {
  const current = getAccountState(state, accountId);
  mutate(current);
  if (current.seenNotificationUris.length > SEEN_NOTIFICATION_IDS_MAX) {
    current.seenNotificationUris = current.seenNotificationUris.slice(
      -SEEN_NOTIFICATION_IDS_MAX,
    );
  }
  state.updatedAt = new Date().toISOString();
}

export function attachmentsDir(): string {
  return join(getChannelDir("bluesky"), "attachments");
}
