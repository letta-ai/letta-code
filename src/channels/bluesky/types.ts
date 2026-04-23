/**
 * Internal types for the Bluesky plugin. Not exported from the channel
 * module — keep these scoped to the plugin package.
 */

import type { BlueskyNotificationReason } from "../types";

export interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
}

export interface BlueskyThreadRefs {
  rootUri?: string;
  rootCid?: string;
  parentUri?: string;
  parentCid?: string;
}

/** Cached so `sendMessage` can post a threaded reply without a round-trip. */
export interface BlueskyLastPost {
  uri: string;
  cid: string;
  threadRoot: { uri: string; cid: string };
  threadParent: { uri: string; cid: string };
  receivedAt: number;
}

export interface BlueskyNotification {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  reason: BlueskyNotificationReason;
  reasonSubject?: string;
  record: Record<string, unknown>;
  indexedAt: string;
}

export interface BlueskyListNotificationsResponse {
  cursor?: string;
  notifications: BlueskyNotification[];
  priority?: boolean;
  seenAt?: string;
}

export interface BlueskyEmbedImage {
  /** URL on the CDN (fullsize). Rendered into the attachment download path. */
  fullsize?: string;
  /** Lower-resolution thumbnail URL. */
  thumb?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
  /** Raw blob cid/mime, if present on the record (not the view). */
  blobCid?: string;
  blobMime?: string;
}

export interface BlueskyThreadPostSummary {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string };
  text: string;
  createdAt?: string;
  replyParent?: string;
  replyRoot?: string;
  langs: string[];
  embedLines: string[];
}

export interface BlueskyThreadContext {
  /** Chronological from thread root → direct parent of the triggering post. */
  ancestors: BlueskyThreadPostSummary[];
}

export interface BlueskyAttachmentDescriptor {
  cid: string;
  index: number;
  extension: string;
  mimeType: string;
  url: string;
  alt?: string;
}
