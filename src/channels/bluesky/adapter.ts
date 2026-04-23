/**
 * Bluesky channel adapter — notifications pipe with a minimal reply path.
 *
 * Responsibilities:
 *   - Keep a live session (create/refresh JWTs on demand).
 *   - Poll `app.bsky.notification.listNotifications` on an interval.
 *   - For each fresh notification, hydrate thread context, download
 *     any embedded images to local disk, and deliver an
 *     `InboundChannelMessage` to the registry.
 *   - Persist the cursor + seen-URIs ring so restarts don't replay.
 *   - Implement `sendMessage` as a plain-text reply to the last post on
 *     that thread. Anything richer (facets, images, quote posts, likes,
 *     follows, blocks) is left to `social-cli`.
 *
 * Non-goals (deferred to v2):
 *   - Jetstream firehose / wantedDids / wantedCollections.
 *   - MessageChannel actions (reply/quote/like/follow/block).
 *   - DM lexicon (`chat.bsky.convo.*`).
 *   - Image uploads, facet parsing, grapheme chunking.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  BlueskyChannelAccount,
  ChannelAdapter,
  ChannelMessageAttachment,
  ChannelThreadContext,
  ChannelThreadContextEntry,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "../types";
import {
  DEFAULT_APPVIEW_URL,
  DEFAULT_NOTIFICATION_REASONS,
  DEFAULT_NOTIFICATIONS_INTERVAL_SEC,
  DEFAULT_SERVICE_URL,
  DEFAULT_THREAD_CONTEXT_DEPTH,
  IMAGE_MAX_COUNT,
  LAST_POST_CACHE_MAX,
  POST_MAX_CHARS,
  STATE_FLUSH_INTERVAL_MS,
} from "./constants";
import { extractPostDetails } from "./formatter";
import {
  dedupeAndOrderNotifications,
  fetchThreadContext,
  listNotifications,
  NotificationsFetchError,
} from "./notifications";
import { createReply } from "./posting";
import { ensureSession } from "./session";
import {
  attachmentsDir,
  getAccountState,
  loadBlueskyState,
  saveBlueskyState,
  updateAccountState,
} from "./state";
import type {
  BlueskyLastPost,
  BlueskyNotification,
  BlueskySession,
  BlueskyThreadContext as BlueskyThreadAncestors,
} from "./types";
import {
  countGraphemes,
  fetchWithTimeout,
  parseAtUri,
  pruneMap,
} from "./utils";

interface NormalizedAccountConfig {
  accountId: string;
  handle: string;
  appPassword: string;
  serviceUrl: string;
  appViewUrl: string;
  intervalMs: number;
  reasons: NonNullable<BlueskyChannelAccount["reasons"]>;
  backfill: boolean;
  threadContextDepth: number;
  allowedUsers: string[];
  dmPolicy: BlueskyChannelAccount["dmPolicy"];
}

function normalizeConfig(
  account: BlueskyChannelAccount,
): NormalizedAccountConfig {
  return {
    accountId: account.accountId,
    handle: account.handle,
    appPassword: account.appPassword,
    serviceUrl: account.serviceUrl || DEFAULT_SERVICE_URL,
    appViewUrl: account.appViewUrl || DEFAULT_APPVIEW_URL,
    intervalMs:
      Math.max(account.intervalSec ?? DEFAULT_NOTIFICATIONS_INTERVAL_SEC, 10) *
      1000,
    reasons:
      account.reasons && account.reasons.length > 0
        ? account.reasons
        : [...DEFAULT_NOTIFICATION_REASONS],
    backfill: account.backfill === true,
    threadContextDepth:
      account.threadContextDepth ?? DEFAULT_THREAD_CONTEXT_DEPTH,
    allowedUsers: account.allowedUsers ?? [],
    dmPolicy: account.dmPolicy,
  };
}

export function createBlueskyAdapter(
  account: BlueskyChannelAccount,
): ChannelAdapter {
  const cfg = normalizeConfig(account);

  let session: BlueskySession | undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let running = false;
  let stateDirty = false;

  const lastPostByChatId = new Map<string, BlueskyLastPost>();

  const state = loadBlueskyState();
  const accountState = getAccountState(state, cfg.accountId);
  if (accountState.auth) session = accountState.auth;

  async function ensureActiveSession(force = false): Promise<BlueskySession> {
    const result = await ensureSession({
      creds: {
        handle: cfg.handle,
        appPassword: cfg.appPassword,
        serviceUrl: cfg.serviceUrl,
      },
      existing: force ? undefined : session,
    });
    if (result.refreshed || !session) {
      session = result.session;
      updateAccountState(state, cfg.accountId, (s) => {
        s.auth = result.session;
      });
      stateDirty = true;
    }
    return result.session;
  }

  function markDirty(): void {
    stateDirty = true;
  }

  function flushState(): void {
    if (!stateDirty) return;
    saveBlueskyState(state);
    stateDirty = false;
  }

  function isAllowedAuthor(did: string): boolean {
    if (cfg.dmPolicy === "open") return true;
    if (cfg.dmPolicy === "allowlist") return cfg.allowedUsers.includes(did);
    // pairing is disallowed at setup — treat defensively here.
    return false;
  }

  async function processNotification(
    notification: BlueskyNotification,
  ): Promise<void> {
    if (!notification.uri || !notification.cid) return;
    if (!session) return;
    if (notification.author.did === session.did) return; // self-reply guard
    if (!isAllowedAuthor(notification.author.did)) return;

    const record = (notification.record ?? {}) as Record<string, unknown>;
    const details = extractPostDetails(record);

    const parentUri =
      details.replyRefs.parentUri ?? notification.reasonSubject ?? undefined;
    const parentCid = details.replyRefs.parentCid;
    const rootUri = details.replyRefs.rootUri ?? parentUri ?? notification.uri;
    const rootCid = details.replyRefs.rootCid ?? parentCid ?? notification.cid;

    // Thread identity lives in chatId (the root AT URI). We intentionally
    // leave threadId null so subsequent replies in the same thread map to
    // the same route instead of minting a new conversation per reply.
    const chatId = rootUri ?? notification.uri;
    const threadId = null;

    // Cache thread refs so sendMessage can reply without a re-fetch.
    const lastPost: BlueskyLastPost = {
      uri: notification.uri,
      cid: notification.cid,
      threadRoot: { uri: rootUri, cid: rootCid },
      threadParent: {
        uri: notification.uri,
        cid: notification.cid,
      },
      receivedAt: Date.now(),
    };
    lastPostByChatId.set(chatId, lastPost);
    pruneMap(lastPostByChatId, LAST_POST_CACHE_MAX);

    let ancestors: BlueskyThreadAncestors | null = null;
    if (cfg.threadContextDepth > 0 && parentUri) {
      try {
        ancestors = await fetchThreadContext({
          appViewUrl: cfg.appViewUrl,
          session,
          uri: parentUri,
          parentDepth: cfg.threadContextDepth,
        });
      } catch (err) {
        console.warn(
          "[Bluesky] fetchThreadContext failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const threadContext = buildChannelThreadContext(ancestors);

    const attachments = await downloadAttachments({
      cid: notification.cid,
      details,
      session,
    });

    const raw = buildRawPayload({
      notification,
      details,
      ancestors,
      chatId,
      threadId,
      attachments,
    });

    const inbound: InboundChannelMessage = {
      channel: "bluesky",
      accountId: cfg.accountId,
      chatId,
      threadId,
      senderId: notification.author.did,
      senderName: notification.author.handle
        ? `@${notification.author.handle}`
        : notification.author.did,
      chatLabel: notification.author.handle
        ? `@${notification.author.handle}`
        : undefined,
      text: details.text ?? "",
      timestamp: parseTimestamp(notification.indexedAt),
      messageId: notification.cid,
      chatType: "channel",
      isMention: notification.reason === "mention",
      attachments: attachments.length > 0 ? attachments : undefined,
      threadContext: threadContext ?? undefined,
      raw,
    };

    updateAccountState(state, cfg.accountId, (s) => {
      if (!s.seenNotificationUris.includes(notification.uri)) {
        s.seenNotificationUris.push(notification.uri);
      }
      s.lastPolledAt = new Date().toISOString();
    });
    markDirty();

    try {
      await adapter.onMessage?.(inbound);
    } catch (err) {
      console.error(
        "[Bluesky] onMessage handler failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function pollOnce(): Promise<void> {
    if (pollInFlight) return;
    pollInFlight = true;

    try {
      const activeSession = await ensureActiveSession();
      const response = await listNotifications({
        serviceUrl: cfg.serviceUrl,
        session: activeSession,
        reasons: cfg.reasons,
        cursor: accountState.notificationsCursor,
      });

      // First poll with no backfill: just advance the cursor silently.
      const isInitial = !accountState.notificationsCursor;
      if (isInitial && !cfg.backfill) {
        updateAccountState(state, cfg.accountId, (s) => {
          s.notificationsCursor = response.cursor;
          s.lastPolledAt = new Date().toISOString();
          for (const n of response.notifications) {
            if (n.uri && !s.seenNotificationUris.includes(n.uri)) {
              s.seenNotificationUris.push(n.uri);
            }
          }
        });
        markDirty();
        flushState();
        return;
      }

      const fresh = dedupeAndOrderNotifications(
        response.notifications,
        accountState.seenNotificationUris,
      );

      for (const notification of fresh) {
        if (!running) break;
        await processNotification(notification);
      }

      if (response.cursor) {
        updateAccountState(state, cfg.accountId, (s) => {
          s.notificationsCursor = response.cursor;
        });
        markDirty();
      }
    } catch (err) {
      if (err instanceof NotificationsFetchError && err.status === 401) {
        console.warn("[Bluesky] Session invalid, forcing reauth on next poll.");
        session = undefined;
        try {
          await ensureActiveSession(true);
        } catch (reAuthErr) {
          console.error(
            "[Bluesky] Reauth failed:",
            reAuthErr instanceof Error ? reAuthErr.message : reAuthErr,
          );
        }
      } else {
        console.warn(
          "[Bluesky] Notifications poll failed:",
          err instanceof Error ? err.message : err,
        );
      }
    } finally {
      pollInFlight = false;
    }
  }

  const adapter: ChannelAdapter = {
    id: `bluesky:${cfg.accountId}`,
    channelId: "bluesky",
    accountId: cfg.accountId,
    name: "Bluesky",

    async start(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await ensureActiveSession();
        flushState();
      } catch (err) {
        running = false;
        throw err;
      }

      await pollOnce();

      pollTimer = setInterval(() => {
        if (!running) return;
        pollOnce().catch((err) => {
          console.warn(
            "[Bluesky] Poll failed:",
            err instanceof Error ? err.message : err,
          );
        });
      }, cfg.intervalMs);

      flushTimer = setInterval(() => {
        flushState();
      }, STATE_FLUSH_INTERVAL_MS);

      console.log(
        `[Bluesky] Adapter running for @${cfg.handle} (interval: ${Math.round(
          cfg.intervalMs / 1000,
        )}s, reasons: ${cfg.reasons.join(",")}, dm_policy: ${cfg.dmPolicy}).`,
      );
    },

    async stop(): Promise<void> {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      flushState();
      console.log(`[Bluesky] Adapter stopped for @${cfg.handle}.`);
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      if (!running) throw new Error("[Bluesky] Adapter not running.");

      const text = msg.text?.trim() ?? "";
      if (!text) {
        throw new Error("[Bluesky] Cannot send an empty reply.");
      }

      const graphemes = countGraphemes(text);
      if (graphemes > POST_MAX_CHARS) {
        throw new Error(
          `[Bluesky] Reply is ${graphemes} graphemes; maximum is ${POST_MAX_CHARS}. ` +
            `Use social-cli for threaded or longer replies: \n` +
            `  social-cli bluesky post --reply-to <uri> --text "..." --threaded`,
        );
      }

      const targetMessageId = msg.replyToMessageId ?? msg.targetMessageId;
      const parentUri = resolveParentUri({
        chatId: msg.chatId,
        targetMessageId,
        lastPosts: lastPostByChatId,
      });
      const anchor = lastPostByChatId.get(msg.chatId);
      if (!parentUri || !anchor) {
        throw new Error(
          "[Bluesky] No cached thread context for this reply. " +
            "Use social-cli to post a reply by AT URI.",
        );
      }

      const activeSession = await ensureActiveSession();
      const result = await createReply({
        serviceUrl: cfg.serviceUrl,
        session: activeSession,
        text,
        target: {
          uri: anchor.uri,
          cid: anchor.cid,
          rootUri: anchor.threadRoot.uri,
          rootCid: anchor.threadRoot.cid,
        },
      });

      if (!result.uri) {
        throw new Error("[Bluesky] Reply succeeded but response had no URI.");
      }
      return { messageId: result.uri };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      _options?: { replyToMessageId?: string },
    ): Promise<void> {
      const anchor = lastPostByChatId.get(chatId);
      if (!anchor) {
        console.warn(
          "[Bluesky] sendDirectReply has no cached thread anchor; skipping.",
        );
        return;
      }
      const activeSession = await ensureActiveSession();
      await createReply({
        serviceUrl: cfg.serviceUrl,
        session: activeSession,
        text,
        target: {
          uri: anchor.uri,
          cid: anchor.cid,
          rootUri: anchor.threadRoot.uri,
          rootCid: anchor.threadRoot.cid,
        },
      });
    },
  };

  return adapter;
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveParentUri(params: {
  chatId: string;
  targetMessageId?: string;
  lastPosts: Map<string, BlueskyLastPost>;
}): string | undefined {
  const anchor = params.lastPosts.get(params.chatId);
  if (!anchor) return undefined;
  if (params.targetMessageId) return params.targetMessageId;
  return anchor.uri;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

interface AttachmentDownloadParams {
  cid: string;
  details: ReturnType<typeof extractPostDetails>;
  session: BlueskySession;
}

async function downloadAttachments(
  params: AttachmentDownloadParams,
): Promise<ChannelMessageAttachment[]> {
  const { details, session } = params;
  if (details.embedImages.length === 0) return [];

  const results: ChannelMessageAttachment[] = [];
  const max = Math.min(details.embedImages.length, IMAGE_MAX_COUNT);
  const dir = join(attachmentsDir(), params.cid);
  mkdirSync(dir, { recursive: true });

  for (let i = 0; i < max; i += 1) {
    const image = details.embedImages[i];
    if (!image) continue;
    const url = resolveImageCdnUrl({
      authorDid: session.did,
      image,
    });
    if (!url) continue;

    try {
      const res = await fetchWithTimeout(url, {});
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = detectExtension(image.blobMime, url);
      const filename = `${i}${ext}`;
      const path = join(dir, filename);
      writeFileSync(path, buffer);
      try {
        chmodSync(path, 0o600);
      } catch {
        /* non-POSIX */
      }
      results.push({
        kind: "image",
        localPath: path,
        mimeType: image.blobMime ?? inferMimeFromExt(ext),
        sizeBytes: buffer.byteLength,
        name: image.alt ? image.alt.slice(0, 80) : undefined,
      });
    } catch (err) {
      console.warn(
        "[Bluesky] Failed to download embed image:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return results;
}

function resolveImageCdnUrl(params: {
  authorDid: string;
  image: { fullsize?: string; thumb?: string; blobCid?: string };
}): string | undefined {
  if (params.image.fullsize) return params.image.fullsize;
  if (params.image.thumb) return params.image.thumb;
  const did = params.authorDid;
  const cid = params.image.blobCid;
  if (!did || !cid) return undefined;
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`;
}

function detectExtension(
  mime: string | undefined,
  url: string | undefined,
): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (url) {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (ext) return ext;
  }
  return ".jpg";
}

function inferMimeFromExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return undefined;
  }
}

interface RawPayloadInput {
  notification: BlueskyNotification;
  details: ReturnType<typeof extractPostDetails>;
  ancestors: BlueskyThreadAncestors | null;
  chatId: string;
  threadId: string | null;
  attachments: ChannelMessageAttachment[];
}

function buildRawPayload(input: RawPayloadInput): Record<string, unknown> {
  const parsed = parseAtUri(input.notification.uri);
  return {
    source: "bluesky",
    reason: input.notification.reason,
    reasonSubject: input.notification.reasonSubject,
    post: {
      uri: input.notification.uri,
      cid: input.notification.cid,
      collection: parsed?.collection,
      rkey: parsed?.rkey,
    },
    author: input.notification.author,
    record: input.notification.record,
    chatId: input.chatId,
    threadId: input.threadId,
    text: input.details.text ?? "",
    createdAt: input.details.createdAt,
    langs: input.details.langs,
    embedLines: input.details.embedLines,
    externalLinks: input.details.externalLinks,
    quotedRecordUri: input.details.quotedRecordUri,
    attachments: input.attachments.map((a) => ({
      kind: a.kind,
      localPath: a.localPath,
      mimeType: a.mimeType,
      name: a.name,
      alt: a.name,
    })),
    threadAncestors: input.ancestors?.ancestors.map((a) => ({
      uri: a.uri,
      handle: a.author.handle,
      text: a.text,
    })),
  };
}

function buildChannelThreadContext(
  ancestors: BlueskyThreadAncestors | null,
): ChannelThreadContext | null {
  if (!ancestors || ancestors.ancestors.length === 0) return null;

  const entries: ChannelThreadContextEntry[] = ancestors.ancestors.map((a) => ({
    messageId: a.uri,
    senderId: a.author.did,
    senderName: a.author.handle ? `@${a.author.handle}` : undefined,
    text: a.text,
  }));

  const starter = entries[0];
  const history = entries.slice(1);

  return {
    label: "Bluesky thread ancestors",
    starter,
    history: history.length > 0 ? history : undefined,
  };
}
