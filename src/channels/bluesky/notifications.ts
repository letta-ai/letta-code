/**
 * Notifications polling + thread-context hydration for the Bluesky adapter.
 *
 * The adapter wires up the timer loop and state persistence; the pure
 * transport logic — building URLs, retrying on auth errors, normalizing
 * the AppView payload — lives here so it can be tested in isolation.
 */

import type { BlueskyNotificationReason } from "../types";
import { DEFAULT_NOTIFICATIONS_LIMIT } from "./constants";
import type {
  BlueskyListNotificationsResponse,
  BlueskyNotification,
  BlueskySession,
  BlueskyThreadContext,
  BlueskyThreadPostSummary,
} from "./types";
import {
  fetchWithTimeout,
  getAppViewUrl,
  getServiceUrl,
  isRecord,
  readString,
} from "./utils";

export interface ListNotificationsParams {
  /**
   * Base URL for authenticated XRPC calls. In practice this is the user's
   * PDS / entryway (bsky.social), NOT the read-only AppView at
   * public.api.bsky.app. The AppView rejects access tokens for
   * `app.bsky.notification.*` — notifications must go through the PDS.
   */
  serviceUrl: string;
  session: BlueskySession;
  reasons: BlueskyNotificationReason[];
  cursor?: string;
  limit?: number;
}

export async function listNotifications(
  params: ListNotificationsParams,
): Promise<BlueskyListNotificationsResponse> {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? DEFAULT_NOTIFICATIONS_LIMIT));
  if (params.cursor) search.set("cursor", params.cursor);
  for (const reason of params.reasons) {
    search.append("reasons", reason);
  }

  const url = `${getServiceUrl(params.serviceUrl)}/xrpc/app.bsky.notification.listNotifications?${search.toString()}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${params.session.accessJwt}`,
    },
  });

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new NotificationsFetchError(
      `listNotifications failed (${res.status}): ${detail || res.statusText}`,
      res.status,
    );
  }

  const body = (await res.json()) as {
    cursor?: string;
    notifications?: BlueskyNotification[];
    priority?: boolean;
    seenAt?: string;
  };
  return {
    cursor: typeof body.cursor === "string" ? body.cursor : undefined,
    notifications: Array.isArray(body.notifications) ? body.notifications : [],
    priority: body.priority,
    seenAt: typeof body.seenAt === "string" ? body.seenAt : undefined,
  };
}

export class NotificationsFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NotificationsFetchError";
    this.status = status;
  }
}

/**
 * Filter a notifications batch down to ones we haven't delivered yet.
 * Returns the filtered list in chronological (oldest → newest) order so
 * the caller can process them in the order they arrived.
 */
export function dedupeAndOrderNotifications(
  notifications: BlueskyNotification[],
  seenUris: Iterable<string>,
): BlueskyNotification[] {
  const seen = new Set(seenUris);
  const fresh = notifications.filter((n) => {
    if (!n.uri) return false;
    if (seen.has(n.uri)) return false;
    return true;
  });
  return [...fresh].reverse();
}

export interface FetchThreadContextParams {
  appViewUrl: string;
  session?: BlueskySession;
  uri: string;
  parentDepth: number;
}

/**
 * Walk parent chain for `uri` and return ancestor posts oldest → newest.
 * Never throws — logs via the caller if the return is `null`.
 */
export async function fetchThreadContext(
  params: FetchThreadContextParams,
): Promise<BlueskyThreadContext | null> {
  if (params.parentDepth <= 0) return null;

  const url = `${getAppViewUrl(params.appViewUrl)}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(params.uri)}&depth=0&parentHeight=${params.parentDepth}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: params.session
        ? { Authorization: `Bearer ${params.session.accessJwt}` }
        : undefined,
    },
    8000,
  );

  if (!res.ok) return null;

  const body = (await res.json()) as {
    thread?: unknown;
  };
  if (!isRecord(body.thread)) return null;

  const summaries: BlueskyThreadPostSummary[] = [];
  let node: unknown = body.thread;
  const safetyBound = Math.max(params.parentDepth + 1, 32);
  let hops = 0;
  while (isRecord(node) && hops < safetyBound) {
    const summary = summarizeThreadNode(node);
    if (summary) summaries.push(summary);
    node = (node as { parent?: unknown }).parent;
    hops += 1;
  }

  if (summaries.length === 0) return null;

  // Collected parent-first; reverse to chronological root → leaf.
  summaries.reverse();
  return { ancestors: summaries };
}

function summarizeThreadNode(
  node: Record<string, unknown>,
): BlueskyThreadPostSummary | null {
  const post = isRecord(node.post) ? node.post : undefined;
  if (!post) return null;
  const record = isRecord(post.record) ? post.record : undefined;
  if (!record) return null;
  const uri = readString(post.uri);
  const cid = readString(post.cid);
  if (!uri || !cid) return null;

  const author = isRecord(post.author) ? post.author : {};
  const did = readString(author.did) ?? "";
  const handle = readString(author.handle) ?? "unknown";
  const displayName = readString(author.displayName);
  const text = readString(record.text) ?? "";
  const createdAt = readString(record.createdAt);

  const reply = isRecord(record.reply) ? record.reply : undefined;
  const replyParent =
    reply && isRecord(reply.parent) ? readString(reply.parent.uri) : undefined;
  const replyRoot =
    reply && isRecord(reply.root) ? readString(reply.root.uri) : undefined;

  const langs = Array.isArray(record.langs)
    ? record.langs.filter((l): l is string => typeof l === "string")
    : [];

  // We intentionally skip the full embed summarizer here — we just want a
  // short textual breadcrumb per parent. The triggering post owns the rich
  // embed metadata via the main formatter.
  const embedLines: string[] = [];
  if (isRecord(record.embed)) {
    const type = readString(record.embed.$type);
    if (type) embedLines.push(`(embed: ${type})`);
  }

  return {
    uri,
    cid,
    author: { did, handle, displayName },
    text,
    createdAt,
    replyParent,
    replyRoot,
    langs,
    embedLines,
  };
}

async function safeReadText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return undefined;
  }
}
