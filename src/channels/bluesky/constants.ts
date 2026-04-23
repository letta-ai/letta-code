/**
 * Shared Bluesky plugin constants.
 *
 * Keep these in one place so tests, setup wizard, runtime deps, and the
 * adapter stay in lockstep when we tune defaults.
 */

export const DEFAULT_SERVICE_URL = "https://bsky.social";
export const DEFAULT_APPVIEW_URL = "https://public.api.bsky.app";

export const DEFAULT_NOTIFICATIONS_INTERVAL_SEC = 60;
export const DEFAULT_NOTIFICATIONS_LIMIT = 50;
export const DEFAULT_THREAD_CONTEXT_DEPTH = 5;

/** AT Protocol lexicon limit for `app.bsky.feed.post` text (graphemes). */
export const POST_MAX_CHARS = 300;

/** Bluesky image lexicon (`app.bsky.embed.images`) byte limit per image. */
export const IMAGE_MAX_BYTES = 976_560;
export const IMAGE_MAX_COUNT = 4;

export const STATE_FILENAME = "state.json";
export const STATE_FLUSH_INTERVAL_MS = 30_000;
export const STATE_VERSION = 1;

/** LRU bounds. Seen-notifications protects against replays; last-post caches thread refs. */
export const SEEN_NOTIFICATION_IDS_MAX = 5_000;
export const LAST_POST_CACHE_MAX = 2_000;

/** Reasons we poll for when the account doesn't override. */
export const DEFAULT_NOTIFICATION_REASONS = [
  "mention",
  "reply",
  "quote",
] as const;

export const FETCH_TIMEOUT_MS = 15_000;
