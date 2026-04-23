/**
 * Extract structured details from Bluesky `app.bsky.feed.post` records and
 * render them into the fields we surface to the agent.
 */

import type {
  BlueskyEmbedImage,
  BlueskyThreadPostSummary,
  BlueskyThreadRefs,
} from "./types";
import { isRecord, readString, readStringArray } from "./utils";

export function parseReplyRefs(
  record: Record<string, unknown>,
): BlueskyThreadRefs {
  const reply = isRecord(record.reply) ? record.reply : undefined;
  if (!reply) return {};
  const root = isRecord(reply.root) ? reply.root : undefined;
  const parent = isRecord(reply.parent) ? reply.parent : undefined;
  return {
    rootUri: readString(root?.uri),
    rootCid: readString(root?.cid),
    parentUri: readString(parent?.uri),
    parentCid: readString(parent?.cid),
  };
}

export interface ExtractedPostDetails {
  text?: string;
  createdAt?: string;
  langs: string[];
  replyRefs: BlueskyThreadRefs;
  embedLines: string[];
  embedImages: BlueskyEmbedImage[];
  externalLinks: { uri: string; title?: string; description?: string }[];
  quotedRecordUri?: string;
}

export function extractPostDetails(
  record: Record<string, unknown>,
): ExtractedPostDetails {
  const text = readString(record.text)?.trim();
  const createdAt = readString(record.createdAt);
  const langs = readStringArray(record.langs);
  const replyRefs = parseReplyRefs(record);
  const { lines, images, externals, quoted } = summarizeEmbedRich(record.embed);
  return {
    text,
    createdAt,
    langs,
    replyRefs,
    embedLines: lines,
    embedImages: images,
    externalLinks: externals,
    quotedRecordUri: quoted,
  };
}

interface EmbedSummary {
  lines: string[];
  images: BlueskyEmbedImage[];
  externals: { uri: string; title?: string; description?: string }[];
  quoted?: string;
}

function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

/**
 * Summarize an embed into human-readable lines PLUS structured image/link
 * data the adapter can use to download attachments and render the XML.
 */
export function summarizeEmbedRich(embed: unknown): EmbedSummary {
  const result: EmbedSummary = { lines: [], images: [], externals: [] };
  if (!isRecord(embed)) return result;

  const embedType = readString(embed.$type);

  if (embedType === "app.bsky.embed.images") {
    const rawImages = Array.isArray(embed.images) ? embed.images : [];
    for (const img of rawImages) {
      if (!isRecord(img)) continue;
      const alt = readString(img.alt);
      const image = isRecord(img.image) ? img.image : undefined;
      const blobRef = isRecord(image?.ref) ? image?.ref : undefined;
      result.images.push({
        alt,
        blobCid: readString(blobRef?.$link),
        blobMime: readString(image?.mimeType),
      });
    }
    const summary = `Embed: ${rawImages.length} image(s)`;
    const firstAlt = result.images.find((img) => img.alt?.trim())?.alt;
    if (firstAlt) {
      result.lines.push(`${summary} (alt: ${truncate(firstAlt, 120)})`);
    } else {
      result.lines.push(summary);
    }
    return result;
  }

  if (embedType === "app.bsky.embed.external") {
    const external = isRecord(embed.external) ? embed.external : undefined;
    const title = external ? readString(external.title) : undefined;
    const uri = external ? readString(external.uri) : undefined;
    const description = external ? readString(external.description) : undefined;
    if (uri) {
      result.externals.push({ uri, title, description });
      const titlePart = title ? ` "${truncate(title, 160)}"` : "";
      result.lines.push(`Embed: link${titlePart} ${uri}`);
      if (description) {
        result.lines.push(`Embed description: ${truncate(description, 240)}`);
      }
    } else {
      result.lines.push("Embed: link");
    }
    return result;
  }

  if (embedType === "app.bsky.embed.record") {
    const record = isRecord(embed.record) ? embed.record : undefined;
    const uri = record ? readString(record.uri) : undefined;
    result.quoted = uri;
    result.lines.push(uri ? `Embed: record ${uri}` : "Embed: record");
    return result;
  }

  if (embedType === "app.bsky.embed.recordWithMedia") {
    const record = isRecord(embed.record) ? embed.record : undefined;
    const nestedRecord = isRecord(record?.record) ? record?.record : undefined;
    const uri = nestedRecord ? readString(nestedRecord.uri) : undefined;
    result.quoted = uri;
    result.lines.push(uri ? `Embed: record ${uri}` : "Embed: record");
    const mediaSummary = summarizeEmbedRich(embed.media);
    result.lines.push(...mediaSummary.lines);
    result.images.push(...mediaSummary.images);
    result.externals.push(...mediaSummary.externals);
    return result;
  }

  if (embedType) {
    result.lines.push(`Embed: ${embedType}`);
  }

  return result;
}

/** Convenience wrapper preserving the lettabot-era call signature. */
export function summarizeEmbed(embed: unknown): string[] {
  return summarizeEmbedRich(embed).lines;
}

/**
 * Convert a normalized ancestor list into clean XML-safe thread context.
 * Caller is responsible for XML-escaping text when emitting.
 */
export function buildThreadContextLines(
  ancestors: BlueskyThreadPostSummary[],
): { handle: string; text: string; uri: string }[] {
  return ancestors.map((post) => ({
    handle: post.author.handle,
    text: post.text,
    uri: post.uri,
  }));
}
