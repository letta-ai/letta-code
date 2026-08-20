import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import type {
  ClaudeDocsDiff,
  ClaudeDocsPageDiff,
  ClaudeDocsPageSnapshot,
  ClaudeDocsSnapshot,
  ClaudeNamedChange,
} from "./types.ts";

export const DEFAULT_LLMS_URL = "https://code.claude.com/docs/llms.txt";
export const OFFICIAL_CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
export const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const WATCHED_PATH_PARTS = [
  "/tools",
  "/cli",
  "/commands",
  "/changelog",
  "/settings",
  "/environment",
  "/env",
  "/permissions",
  "/headless",
  "/how-it-works",
  "/sub-agents",
  "/subagents",
  "/worktrees",
  "/interactive",
  "/hooks",
  "/agent-sdk",
  "/claude-agent-sdk",
] as const;

export type DocsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CaptureDocsOptions {
  fetch?: DocsFetch;
  indexUrl?: string;
  previous?: ClaudeDocsSnapshot | null;
  forceFullScan?: boolean;
  packageRelease?: boolean;
  now?: Date | string | number;
  timeoutMs?: number;
  retries?: number;
  retryBackoffMs?: number;
}

export interface CapturedDocs {
  snapshot: ClaudeDocsSnapshot;
  /** Normalized markdown, keyed by the snapshot's deterministic source_path. */
  sources: Record<string, string>;
}

export interface DiffDocsOptions {
  previousSources?: Record<string, string>;
  currentSources?: Record<string, string>;
  maxPreviewLines?: number;
  maxPreviewChars?: number;
}

/** llms.txt is an index, not prose: every absolute HTTP(S) URL ending in .md is authoritative. */
export function parseLlmsTxt(text: string): string[] {
  const urls = new Set<string>();
  const pattern = /https?:\/\/[^\s<>"'`]+/gu;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[0].replace(/[),.;:\]}]+$/u, "");
    try {
      const url = new URL(candidate);
      if (url.pathname.toLowerCase().endsWith(".md")) {
        url.hash = "";
        urls.add(url.toString());
      }
    } catch {
      // A malformed absolute URL cannot be fetched and is intentionally ignored.
    }
  }
  return [...urls].sort();
}

/**
 * Normalize only transport/presentation noise. In particular, leading whitespace,
 * blank lines, headings, tables, code and identifier spelling remain untouched.
 */
export function normalizeDocsMarkdown(input: string): string {
  const lines = input
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const seenBanners = new Set<string>();
  const normalized: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/[\t ]+$/u, "");
    if (isDocsBanner(line)) {
      const key = line.trim().toLowerCase();
      if (seenBanners.has(key)) continue;
      seenBanners.add(key);
    }
    normalized.push(line);
  }

  while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
    normalized.pop();
  }
  return `${normalized.join("\n")}\n`;
}

function isDocsBanner(line: string): boolean {
  const value = line
    .trim()
    .replace(/^#+\s*/u, "")
    .replace(/^>\s*/u, "");
  return /^(?:anthropic\s+)?claude(?:\s+code)?\s+docs(?:umentation)?$/iu.test(
    value,
  );
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashDocsMarkdown(content: string): string {
  return sha256(normalizeDocsMarkdown(content));
}

export function isWatchedDocsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase().replace(/\.md$/u, "");
    const slugParts = path.split("/").filter(Boolean);
    return (
      WATCHED_PATH_PARTS.some((part) => {
        const watched = part.slice(1);
        return (
          path.includes(`${part}/`) ||
          slugParts.some(
            (slug) =>
              slug === watched ||
              slug.startsWith(`${watched}-`) ||
              slug.endsWith(`-${watched}`),
          )
        );
      }) || slugParts.some((slug) => /^(?:how-.*-works|env-vars)$/u.test(slug))
    );
  } catch {
    return false;
  }
}

export function deterministicSourcePath(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-");
  const path = decodeURIComponent(url.pathname)
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.md$/iu, "")
    .split("/")
    .map((part) =>
      part.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, ""),
    )
    .filter(Boolean)
    .join("/");
  const query = url.search ? `-${sha256(url.search).slice(0, 10)}` : "";
  return `sources/${host}/${path || "index"}${query}.md`;
}

export function shouldFullScan(options: CaptureDocsOptions): boolean {
  if (options.forceFullScan || options.packageRelease || !options.previous)
    return true;
  const now = toDate(options.now ?? new Date()).getTime();
  const lastFullScanAt = Date.parse(options.previous.scanned_at);
  return (
    !Number.isFinite(lastFullScanAt) ||
    now - lastFullScanAt >= FULL_SCAN_INTERVAL_MS
  );
}

export async function captureDocsSnapshot(
  options: CaptureDocsOptions = {},
): Promise<CapturedDocs> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const indexUrl = options.indexUrl ?? DEFAULT_LLMS_URL;
  const allowedOrigin = new URL(indexUrl).origin;
  const fixedAllowedUrls = new Set(
    indexUrl === DEFAULT_LLMS_URL ? [OFFICIAL_CHANGELOG_URL] : [],
  );
  const now = toDate(options.now ?? new Date());
  const indexText = await fetchText(
    indexUrl,
    fetcher,
    options,
    allowedOrigin,
    fixedAllowedUrls,
  );
  const normalizedIndex = normalizeDocsMarkdown(indexText);
  const urls = [
    ...new Set([...parseLlmsTxt(indexText), ...fixedAllowedUrls]),
  ].sort();
  const fullScan = shouldFullScan(options);
  const pages: Record<string, ClaudeDocsPageSnapshot> = {};
  const sources: Record<string, string> = {
    "sources/llms.txt": normalizedIndex,
  };

  const capturedPages = await mapConcurrent(urls, 8, async (url) => {
    const watched = isWatchedDocsUrl(url);
    const oldPage = options.previous?.pages[url];
    if (!fullScan && !watched && oldPage) {
      return {
        page: { ...oldPage, watched: false, source_path: null },
        source: null,
      };
    }
    // A newly indexed unwatched page has no truthful hash to reuse, so fetch it
    // once. Established unwatched pages above remain network-free incrementally.
    const normalized = normalizeDocsMarkdown(
      await fetchText(url, fetcher, options, allowedOrigin, fixedAllowedUrls),
    );
    const sourcePath = watched ? deterministicSourcePath(url) : null;
    return {
      page: {
        url,
        hash: sha256(normalized),
        watched,
        source_path: sourcePath,
      },
      source: sourcePath ? ([sourcePath, normalized] as const) : null,
    };
  });
  for (const { page, source } of capturedPages) {
    pages[page.url] = page;
    if (source) sources[source[0]] = source[1];
  }

  const snapshotWithoutDigest = {
    index_url: indexUrl,
    index_hash: sha256(normalizedIndex),
    full_scan: fullScan,
    // Preserve the last full-scan clock across incremental captures so the
    // 24-hour policy remains enforceable with the persisted snapshot schema.
    scanned_at: fullScan
      ? now.toISOString()
      : (options.previous?.scanned_at ?? now.toISOString()),
    pages: sortRecord(pages),
  };
  const digest = docsDigest(
    snapshotWithoutDigest.index_hash,
    snapshotWithoutDigest.pages,
  );
  return {
    snapshot: { ...snapshotWithoutDigest, digest },
    sources: sortRecord(sources),
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function docsDigest(
  indexHash: string,
  pages: Record<string, ClaudeDocsPageSnapshot>,
): string {
  // scanned_at and full_scan are operational metadata, not documentation content.
  return sha256(
    JSON.stringify({
      index_hash: indexHash,
      pages: Object.keys(pages)
        .sort()
        .map((url) => [url, pages[url]?.hash]),
    }),
  );
}

async function fetchText(
  url: string,
  fetcher: DocsFetch,
  options: CaptureDocsOptions,
  allowedOrigin: string,
  fixedAllowedUrls: ReadonlySet<string>,
): Promise<string> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const backoff = options.retryBackoffMs ?? 250;
  let lastError: unknown;
  let currentUrl = url;
  let redirects = 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      assertAllowedDocsUrl(currentUrl, allowedOrigin, fixedAllowedUrls);
      const response = await fetcher(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        redirects += 1;
        if (redirects > 3)
          throw new Error(`Too many redirects fetching ${url}`);
        const location = response.headers.get("location");
        if (!location)
          throw new Error(`Redirect without Location from ${currentUrl}`);
        const redirected = new URL(location, currentUrl).toString();
        assertAllowedDocsUrl(redirected, allowedOrigin, fixedAllowedUrls);
        currentUrl = redirected;
        attempt -= 1;
        continue;
      }
      if (!response.ok)
        throw new Error(`HTTP ${response.status} fetching ${currentUrl}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries && backoff > 0) await sleep(backoff * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url}`);
}

function assertAllowedDocsUrl(
  value: string,
  allowedOrigin: string,
  fixedAllowedUrls: ReadonlySet<string>,
): void {
  const url = new URL(value);
  url.hash = "";
  if (
    url.protocol !== "https:" ||
    (url.origin !== allowedOrigin && !fixedAllowedUrls.has(url.toString())) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Refusing documentation URL outside ${allowedOrigin}: ${value}`,
    );
  }
}

export function diffDocsSnapshots(
  previous: ClaudeDocsSnapshot | null,
  current: ClaudeDocsSnapshot,
  options: DiffDocsOptions = {},
): ClaudeDocsDiff {
  const previousPages = previous?.pages ?? {};
  const oldUrls = new Set(Object.keys(previousPages));
  const newUrls = new Set(Object.keys(current.pages));
  const addedPages = [...newUrls].filter((url) => !oldUrls.has(url)).sort();
  const removedPages = [...oldUrls].filter((url) => !newUrls.has(url)).sort();
  const changedPages = [...newUrls]
    .filter(
      (url) =>
        oldUrls.has(url) &&
        previousPages[url]?.hash !== current.pages[url]?.hash,
    )
    .sort();

  const watchedPageDiffs: ClaudeDocsPageDiff[] = [];
  const oldNamed = emptyNamedMaps();
  const newNamed = emptyNamedMaps();
  const relevant = [
    ...new Set([...addedPages, ...removedPages, ...changedPages]),
  ].sort();
  for (const url of relevant) {
    const oldPage = previousPages[url];
    const newPage = current.pages[url];
    const sourcePath = newPage?.source_path ?? oldPage?.source_path ?? null;
    if (!sourcePath) continue;
    const oldText = oldPage?.source_path
      ? options.previousSources?.[oldPage.source_path]
      : undefined;
    const newText = newPage?.source_path
      ? options.currentSources?.[newPage.source_path]
      : undefined;
    if (oldText === undefined && newText === undefined) continue;
    const preview = unifiedDiff(
      oldText ?? "",
      newText ?? "",
      sourcePath,
      options.maxPreviewLines ?? 160,
      options.maxPreviewChars ?? 20_000,
    );
    watchedPageDiffs.push({ url, source_path: sourcePath, ...preview });
    mergeNamedMaps(oldNamed, extractNamedEntries(oldText ?? ""));
    mergeNamedMaps(newNamed, extractNamedEntries(newText ?? ""));
  }

  return {
    added_pages: addedPages,
    removed_pages: removedPages,
    changed_pages: changedPages,
    watched_page_diffs: watchedPageDiffs,
    tools: compareNames(oldNamed.tools, newNamed.tools),
    cli: compareNames(oldNamed.cli, newNamed.cli),
    settings: compareNames(oldNamed.settings, newNamed.settings),
    env_vars: compareNames(oldNamed.env_vars, newNamed.env_vars),
    permission_rules: compareNames(
      oldNamed.permission_rules,
      newNamed.permission_rules,
    ),
  };
}

type NamedSets = Record<
  "tools" | "cli" | "settings" | "env_vars" | "permission_rules",
  Set<string>
>;

function emptyNamedCollections(): NamedSets {
  return {
    tools: new Set(),
    cli: new Set(),
    settings: new Set(),
    env_vars: new Set(),
    permission_rules: new Set(),
  };
}

type NamedMaps = Record<keyof NamedSets, Map<string, string>>;

function emptyNamedMaps(): NamedMaps {
  return {
    tools: new Map(),
    cli: new Map(),
    settings: new Map(),
    env_vars: new Map(),
    permission_rules: new Map(),
  };
}

function mergeNamedMaps(target: NamedMaps, source: NamedMaps): void {
  for (const key of Object.keys(target) as Array<keyof NamedMaps>) {
    for (const [name, signature] of source[key]) {
      const existing = target[key].get(name);
      target[key].set(
        name,
        existing ? sha256(`${existing}\n${signature}`) : signature,
      );
    }
  }
}

/** Extract only names presented in strongly-labelled documentation contexts. */
export function extractNamedChanges(markdown: string): NamedSets {
  const result = emptyNamedCollections();
  const lines = normalizeDocsMarkdown(markdown).split("\n");
  let heading = "";
  let tableKind: keyof NamedSets | null = null;
  let tableNameColumn = -1;

  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.+)$/u.exec(line);
    if (headingMatch?.[1]) {
      heading = headingMatch[1].toLowerCase();
      tableKind = null;
      tableNameColumn = -1;
    }

    if (line.includes("|") && /^\s*\|/u.test(line)) {
      const cells = tableCells(line);
      const lower = cells.map((cell) => cell.toLowerCase());
      if (lower.some((cell) => /^(tool|tool name)$/u.test(cell))) {
        tableKind = "tools";
        tableNameColumn = lower.findIndex((cell) =>
          /^(tool|tool name)$/u.test(cell),
        );
        continue;
      }
      const contextualKind = headingKind(heading);
      const nameColumn = lower.findIndex((cell) =>
        /^(name|setting|variable|rule|command|flag)$/u.test(cell),
      );
      if (contextualKind && nameColumn >= 0) {
        tableKind = contextualKind;
        tableNameColumn = nameColumn;
        continue;
      }
      if (tableKind && !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
        const value = cleanName(cells[tableNameColumn] ?? "");
        if (
          value &&
          (tableKind !== "tools" ||
            /^(?:[A-Z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_]+)$/u.test(value))
        ) {
          result[tableKind].add(value);
        }
      }
    }

    if (/\b(?:cli|command|flags?|options?)\b/iu.test(heading)) {
      for (const match of line.matchAll(
        /(?:^|[\s`,(])(--[a-z0-9][a-z0-9-]*)(?=$|[\s`,)=])/giu,
      )) {
        if (match[1]) result.cli.add(match[1]);
      }
      for (const match of line.matchAll(
        /`(claude(?:\s+[a-z][a-z0-9-]*)+)`/giu,
      )) {
        if (match[1]) result.cli.add(match[1]);
      }
    }
    if (/\b(?:settings?|configuration)\b/iu.test(heading)) {
      for (const match of line.matchAll(
        /`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)+)`/gu,
      )) {
        if (match[1]) result.settings.add(match[1]);
      }
    }
    if (/\b(?:environment|env(?:ironment)? variables?)\b/iu.test(heading)) {
      for (const match of line.matchAll(/`([A-Z][A-Z0-9_]{2,})`/gu)) {
        if (match[1]) result.env_vars.add(match[1]);
      }
    }
    if (/\bpermissions?\b/iu.test(heading)) {
      for (const match of line.matchAll(
        /`((?:allow|deny|ask)(?:\([^`\n]+\)|\.[a-zA-Z0-9_.-]+))`/gu,
      )) {
        if (match[1]) result.permission_rules.add(match[1]);
      }
    }
  }
  return result;
}

function extractNamedEntries(markdown: string): NamedMaps {
  const names = extractNamedChanges(markdown);
  const result = emptyNamedMaps();
  const lines = normalizeDocsMarkdown(markdown).split("\n");
  for (const key of Object.keys(names) as Array<keyof NamedSets>) {
    for (const name of names[key]) {
      // Tie a name to only the strongly-labelled line that exposed it. This
      // reports table-row/flag-description edits without interpreting prose.
      const evidence = lines.filter((line) => line.includes(name)).join("\n");
      result[key].set(name, sha256(evidence));
    }
  }
  return result;
}

function headingKind(heading: string): keyof NamedSets | null {
  if (/\btools?\b/u.test(heading)) return "tools";
  if (/\b(?:cli|commands?|flags?|options?)\b/u.test(heading)) return "cli";
  if (/\b(?:settings?|configuration)\b/u.test(heading)) return "settings";
  if (/\b(?:environment|env variables?)\b/u.test(heading)) return "env_vars";
  if (/\bpermissions?\b/u.test(heading)) return "permission_rules";
  return null;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

function cleanName(value: string): string | null {
  const cleaned = value.replace(/[*_]/gu, "").replace(/^`|`$/gu, "").trim();
  if (
    !cleaned ||
    /^:?-{3,}:?$/u.test(cleaned) ||
    cleaned.length > 120 ||
    /\n/u.test(cleaned)
  )
    return null;
  return cleaned;
}

function compareNames(
  oldNames: Map<string, string>,
  newNames: Map<string, string>,
): ClaudeNamedChange {
  return {
    added: [...newNames.keys()].filter((name) => !oldNames.has(name)).sort(),
    removed: [...oldNames.keys()].filter((name) => !newNames.has(name)).sort(),
    changed: [...newNames.keys()]
      .filter(
        (name) =>
          oldNames.has(name) && oldNames.get(name) !== newNames.get(name),
      )
      .sort(),
  };
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  sourcePath: string,
  maxLines = 160,
  maxChars = 20_000,
): { preview: string; truncated: boolean } {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const patch = createTwoFilesPatch(
    `a/${sourcePath}`,
    `b/${sourcePath}`,
    oldLines.join("\n"),
    newLines.join("\n"),
    "",
    "",
    { context: 3 },
  );
  const output = patch.split("\n").filter((line, index) => {
    return !(index === 0 && /^=+$/u.test(line));
  });
  let preview = output.join("\n");
  let truncated = false;
  if (output.length > maxLines) {
    preview = [
      ...output.slice(0, Math.max(0, maxLines - 1)),
      `... [diff truncated: ${output.length - maxLines + 1} lines omitted] ...`,
    ].join("\n");
    truncated = true;
  }
  if (preview.length > maxChars) {
    const marker = `\n... [diff truncated: character limit ${maxChars}] ...`;
    preview = `${preview.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
    truncated = true;
  }
  return { preview, truncated };
}

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function toDate(value: Date | string | number): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error(`Invalid snapshot time: ${String(value)}`);
  return date;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
