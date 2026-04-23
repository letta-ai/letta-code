/**
 * Plain utilities for the Bluesky plugin.
 *
 * Kept free of runtime-loaded deps (@atproto/api, undici) so tests can
 * import these modules without paying the install cost.
 */

import { FETCH_TIMEOUT_MS } from "./constants";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
    : [];
}

/**
 * Parse an AT Protocol URI of the form `at://<did>/<collection>/<rkey>`.
 * Returns `undefined` on malformed input.
 */
export function parseAtUri(
  uri: string,
): { did: string; collection: string; rkey: string } | undefined {
  if (!uri.startsWith("at://")) return undefined;
  const parts = uri.slice("at://".length).split("/");
  if (parts.length < 3) return undefined;
  const [did, collection, rkey] = parts;
  if (!did || !collection || !rkey) return undefined;
  return { did, collection, rkey };
}

export function buildAtUri(
  did?: string,
  collection?: string,
  rkey?: string,
): string | undefined {
  if (!did || !collection || !rkey) return undefined;
  return `at://${did}/${collection}/${rkey}`;
}

/**
 * Strip trailing slashes from a base URL so path concatenation stays clean.
 */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getAppViewUrl(
  appViewUrl?: string,
  defaultUrl = "https://public.api.bsky.app",
): string {
  return trimBaseUrl(appViewUrl || defaultUrl);
}

export function getServiceUrl(
  serviceUrl?: string,
  defaultUrl = "https://bsky.social",
): string {
  return trimBaseUrl(serviceUrl || defaultUrl);
}

/**
 * `fetch` with an AbortController-based timeout. Throws on timeout rather
 * than hanging — callers handle the retry cadence.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Split text into grapheme-safe chunks for threaded posting. Respects the
 * AT Protocol 300-grapheme post limit. Empty output when the input is blank.
 */
export function splitPostText(text: string, maxChars = 300): string[] {
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(text)].map((s) => s.segment);
  if (graphemes.length === 0) return [];
  if (graphemes.length <= maxChars) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < graphemes.length) {
    let end = Math.min(start + maxChars, graphemes.length);
    if (end < graphemes.length) {
      let split = end;
      for (let i = end - 1; i > start; i--) {
        const g = graphemes[i];
        if (g && /\s/.test(g)) {
          split = i;
          break;
        }
      }
      end = split > start ? split : end;
    }

    const chunk = graphemes
      .slice(start, end)
      .join("")
      .replace(/^\s+|\s+$/g, "");
    if (chunk) chunks.push(chunk);

    start = end;
    while (start < graphemes.length) {
      const g = graphemes[start];
      if (!g || !/\s/.test(g)) break;
      start += 1;
    }
  }

  return chunks;
}

/** Count graphemes in `text` — respects the AT Protocol post length rule. */
export function countGraphemes(text: string): number {
  const segmenter = new Intl.Segmenter();
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/**
 * Best-effort decode of a JWT's `exp` claim. Returns milliseconds-since-epoch
 * or `undefined` when the token can't be parsed.
 */
export function decodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const data = JSON.parse(json) as { exp?: number };
    if (typeof data.exp === "number") return data.exp * 1000;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function pruneMap<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
