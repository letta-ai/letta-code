import { expect, test } from "bun:test";
import {
  extractPostDetails,
  parseReplyRefs,
  summarizeEmbedRich,
} from "../../channels/bluesky/formatter";
import { dedupeAndOrderNotifications } from "../../channels/bluesky/notifications";
import type { BlueskyNotification } from "../../channels/bluesky/types";
import {
  buildAtUri,
  countGraphemes,
  decodeJwtExp,
  parseAtUri,
  pruneMap,
  splitPostText,
} from "../../channels/bluesky/utils";

// ── utils ───────────────────────────────────────────────────────────

test("parseAtUri parses a well-formed post uri", () => {
  expect(parseAtUri("at://did:plc:abc/app.bsky.feed.post/abc123")).toEqual({
    did: "did:plc:abc",
    collection: "app.bsky.feed.post",
    rkey: "abc123",
  });
});

test("parseAtUri returns undefined for garbage", () => {
  expect(parseAtUri("")).toBeUndefined();
  expect(parseAtUri("at://just-did")).toBeUndefined();
  expect(parseAtUri("https://example.com")).toBeUndefined();
});

test("buildAtUri round-trips with parseAtUri", () => {
  const uri = buildAtUri("did:plc:abc", "app.bsky.feed.post", "xyz");
  expect(uri).toBe("at://did:plc:abc/app.bsky.feed.post/xyz");
  expect(parseAtUri(uri!)).toEqual({
    did: "did:plc:abc",
    collection: "app.bsky.feed.post",
    rkey: "xyz",
  });
});

test("countGraphemes counts composed emoji as one", () => {
  expect(countGraphemes("hello")).toBe(5);
  // family emoji = multiple code points, 1 grapheme
  expect(countGraphemes("👨‍👩‍👧")).toBe(1);
});

test("splitPostText respects grapheme limit and word boundaries", () => {
  const chunks = splitPostText("one two three four five six", 10);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(countGraphemes(chunk)).toBeLessThanOrEqual(10);
  }
  expect(chunks.join(" ")).toBe("one two three four five six");
});

test("splitPostText returns empty array for whitespace-only input", () => {
  expect(splitPostText("   ")).toEqual([]);
});

test("decodeJwtExp reads exp claim", () => {
  const payload = Buffer.from(
    JSON.stringify({ exp: 1_700_000_000 }),
    "utf-8",
  ).toString("base64url");
  const jwt = `header.${payload}.sig`;
  expect(decodeJwtExp(jwt)).toBe(1_700_000_000 * 1000);
});

test("pruneMap trims oldest entries", () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 10; i += 1) map.set(String(i), i);
  pruneMap(map, 5);
  expect(map.size).toBe(5);
  // Oldest entries (smallest keys) should be evicted first.
  expect(map.has("0")).toBe(false);
  expect(map.has("9")).toBe(true);
});

// ── formatter ───────────────────────────────────────────────────────

test("parseReplyRefs returns empty for non-reply", () => {
  expect(parseReplyRefs({ text: "hi" })).toEqual({});
});

test("parseReplyRefs extracts root/parent uris", () => {
  const refs = parseReplyRefs({
    reply: {
      root: { uri: "at://root", cid: "rootCid" },
      parent: { uri: "at://parent", cid: "parentCid" },
    },
  });
  expect(refs).toEqual({
    rootUri: "at://root",
    rootCid: "rootCid",
    parentUri: "at://parent",
    parentCid: "parentCid",
  });
});

test("extractPostDetails surfaces embed images", () => {
  const details = extractPostDetails({
    text: "hi",
    createdAt: "2025-01-01T00:00:00Z",
    embed: {
      $type: "app.bsky.embed.images",
      images: [
        {
          alt: "a cat",
          image: {
            $type: "blob",
            mimeType: "image/jpeg",
            ref: { $link: "bafyCID" },
          },
        },
      ],
    },
  });
  expect(details.text).toBe("hi");
  expect(details.embedImages).toHaveLength(1);
  expect(details.embedImages[0]?.blobCid).toBe("bafyCID");
  expect(details.embedImages[0]?.alt).toBe("a cat");
  expect(details.embedLines[0]).toContain("alt: a cat");
});

test("summarizeEmbedRich captures external link metadata", () => {
  const summary = summarizeEmbedRich({
    $type: "app.bsky.embed.external",
    external: {
      uri: "https://example.com",
      title: "Title",
      description: "Desc",
    },
  });
  expect(summary.externals[0]).toEqual({
    uri: "https://example.com",
    title: "Title",
    description: "Desc",
  });
  expect(summary.lines.join("\n")).toContain("Title");
});

test("summarizeEmbedRich records quoted post uris", () => {
  const summary = summarizeEmbedRich({
    $type: "app.bsky.embed.record",
    record: { uri: "at://did:plc:abc/app.bsky.feed.post/abc" },
  });
  expect(summary.quoted).toBe("at://did:plc:abc/app.bsky.feed.post/abc");
});

// ── notifications ───────────────────────────────────────────────────

function makeNotif(uri: string, reason = "mention"): BlueskyNotification {
  return {
    uri,
    cid: `cid-${uri}`,
    author: { did: `did:plc:${uri}`, handle: `${uri}.bsky.social` },
    reason: reason as BlueskyNotification["reason"],
    reasonSubject: undefined,
    record: { $type: "app.bsky.feed.post", text: `post ${uri}` },
    indexedAt: "2025-01-01T00:00:00Z",
  };
}

test("dedupeAndOrderNotifications filters already-seen uris", () => {
  const fresh = dedupeAndOrderNotifications(
    [makeNotif("a"), makeNotif("b"), makeNotif("c")],
    ["b"],
  );
  expect(fresh.map((n) => n.uri)).toEqual(["c", "a"]);
});

test("dedupeAndOrderNotifications reverses to chronological order", () => {
  // listNotifications returns newest → oldest. We want oldest → newest.
  const fresh = dedupeAndOrderNotifications(
    [makeNotif("newest"), makeNotif("middle"), makeNotif("oldest")],
    [],
  );
  expect(fresh.map((n) => n.uri)).toEqual(["oldest", "middle", "newest"]);
});

test("dedupeAndOrderNotifications drops entries without uris", () => {
  const fresh = dedupeAndOrderNotifications(
    [{ ...makeNotif("valid") }, { ...makeNotif("skip"), uri: "" }],
    [],
  );
  expect(fresh.map((n) => n.uri)).toEqual(["valid"]);
});
