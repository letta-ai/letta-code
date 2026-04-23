/**
 * Minimal Bluesky posting primitive used by `adapter.sendMessage`.
 *
 * v1 is reply-only: we produce plain-text `app.bsky.feed.post` records
 * rooted in a known thread. No facets, no images, no chunking. Callers
 * who need anything more go through `social-cli` (which owns the full
 * posting surface).
 */

import type { BlueskySession } from "./types";
import { fetchWithTimeout, getServiceUrl, parseAtUri } from "./utils";

export interface ReplyTarget {
  /** URI of the post we're replying to (i.e. the parent). */
  uri: string;
  /** CID of the post we're replying to. Required for the reply record. */
  cid: string;
  /** Thread root URI. Defaults to `uri` when the parent is itself the root. */
  rootUri?: string;
  /** Thread root CID. Defaults to `cid` when the parent is itself the root. */
  rootCid?: string;
}

export interface CreatedRecord {
  uri: string;
  cid?: string;
}

export interface CreateReplyParams {
  serviceUrl?: string;
  session: BlueskySession;
  text: string;
  target: ReplyTarget;
}

/**
 * Create a plain-text reply post. Returns the AT URI and cid of the new post.
 */
export async function createReply(
  params: CreateReplyParams,
): Promise<CreatedRecord> {
  const { session, target } = params;
  const text = params.text.trim();
  if (!text) throw new Error("Bluesky reply text is empty.");

  const rootUri = target.rootUri || target.uri;
  const rootCid = target.rootCid || target.cid;
  if (!rootUri || !rootCid || !target.uri || !target.cid) {
    throw new Error(
      "createReply requires root uri+cid and parent uri+cid to build the reply record.",
    );
  }

  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    reply: {
      root: { uri: rootUri, cid: rootCid },
      parent: { uri: target.uri, cid: target.cid },
    },
  };

  const url = `${getServiceUrl(params.serviceUrl)}/xrpc/com.atproto.repo.createRecord`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `com.atproto.repo.createRecord failed (${res.status}): ${detail || res.statusText}`,
    );
  }

  const body = (await res.json()) as CreatedRecord;
  if (!body.uri) {
    throw new Error(
      "com.atproto.repo.createRecord returned without a URI — cannot confirm reply.",
    );
  }
  if (!body.cid) {
    body.cid = await resolveRecordCid({
      uri: body.uri,
      serviceUrl: params.serviceUrl,
      session,
    });
  }
  return body;
}

async function resolveRecordCid(params: {
  uri: string;
  serviceUrl?: string;
  session: BlueskySession;
}): Promise<string | undefined> {
  const parsed = parseAtUri(params.uri);
  if (!parsed) return undefined;
  const qs = new URLSearchParams({
    repo: parsed.did,
    collection: parsed.collection,
    rkey: parsed.rkey,
  });
  const url = `${getServiceUrl(params.serviceUrl)}/xrpc/com.atproto.repo.getRecord?${qs.toString()}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${params.session.accessJwt}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { cid?: string };
    return data.cid;
  } catch {
    return undefined;
  }
}

async function safeReadText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return undefined;
  }
}
