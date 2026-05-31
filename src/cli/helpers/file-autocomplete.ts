import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Ported from Pi TUI packages/tui/src/autocomplete.ts.
// Keep behavior aligned with Pi's fd-backed @ file autocomplete.
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
  const normalized = toDisplayPath(query);
  if (!normalized.includes("/")) {
    return normalized;
  }

  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return normalized;
  }

  const separatorPattern = "[\\\\/]";
  const segments = trimmed
    .split("/")
    .filter(Boolean)
    .map((segment) => escapeRegex(segment));
  if (segments.length === 0) {
    return normalized;
  }

  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) {
    pattern += separatorPattern;
  }
  return pattern;
}

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) {
      return i;
    }
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) {
        quoteStart = i;
      }
    }
  }

  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) {
    return null;
  }

  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) {
      return null;
    }
    return text.slice(quoteStart - 1);
  }

  if (!isTokenStart(text, quoteStart)) {
    return null;
  }

  return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): {
  rawPrefix: string;
  isAtPrefix: boolean;
  isQuotedPrefix: boolean;
} {
  if (prefix.startsWith('@"')) {
    return {
      rawPrefix: prefix.slice(2),
      isAtPrefix: true,
      isQuotedPrefix: true,
    };
  }
  if (prefix.startsWith('"')) {
    return {
      rawPrefix: prefix.slice(1),
      isAtPrefix: false,
      isQuotedPrefix: true,
    };
  }
  if (prefix.startsWith("@")) {
    return {
      rawPrefix: prefix.slice(1),
      isAtPrefix: true,
      isQuotedPrefix: false,
    };
  }
  return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
  path: string,
  options: {
    isDirectory: boolean;
    isAtPrefix: boolean;
    isQuotedPrefix: boolean;
  },
): string {
  const needsQuotes = options.isQuotedPrefix || path.includes(" ");
  const prefix = options.isAtPrefix ? "@" : "";

  if (!needsQuotes) {
    return `${prefix}${path}`;
  }

  const openQuote = `${prefix}"`;
  const closeQuote = '"';
  return `${openQuote}${path}${closeQuote}`;
}

async function walkDirectoryWithFd(
  baseDir: string,
  fdPath: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];

  if (toDisplayPath(query).includes("/")) {
    args.push("--full-path");
  }

  if (query) {
    args.push(buildFdPathQuery(query));
  }

  return await new Promise((resolve) => {
    if (signal.aborted) {
      resolve([]);
      return;
    }

    const child = spawn(fdPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let resolved = false;

    const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener("abort", onAbort);
      resolve(results);
    };

    const onAbort = () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (!child.stdout) {
      finish([]);
      return;
    }
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      finish([]);
    });
    child.on("close", (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        finish([]);
        return;
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      const results: Array<{ path: string; isDirectory: boolean }> = [];

      for (const line of lines) {
        const displayLine = toDisplayPath(line);
        const hasTrailingSeparator = displayLine.endsWith("/");
        const normalizedPath = hasTrailingSeparator
          ? displayLine.slice(0, -1)
          : displayLine;
        if (
          normalizedPath === ".git" ||
          normalizedPath.startsWith(".git/") ||
          normalizedPath.includes("/.git/")
        ) {
          continue;
        }

        results.push({
          path: displayLine,
          isDirectory: hasTrailingSeparator,
        });
      }

      finish(results);
    });
  });
}

export interface FileAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface FileAutocompleteSuggestions {
  items: FileAutocompleteItem[];
  prefix: string;
}

export interface AppliedFileCompletion {
  value: string;
  cursorPosition: number;
}

export function resolveFdPath(): string | null {
  for (const binaryName of ["fd", "fdfind"]) {
    try {
      const result = spawnSync(binaryName, ["--version"], { stdio: "pipe" });
      if (!result.error) {
        return binaryName;
      }
    } catch {
      // Try the next binary name.
    }
  }

  return null;
}

export function applyPiFileCompletion(
  currentInput: string,
  cursorPosition: number,
  item: FileAutocompleteItem,
  prefix: string,
): AppliedFileCompletion {
  const beforePrefix = currentInput.slice(0, cursorPosition - prefix.length);
  const afterCursor = currentInput.slice(cursorPosition);
  const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
  const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
  const hasTrailingQuoteInItem = item.value.endsWith('"');
  const adjustedAfterCursor =
    isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor
      ? afterCursor.slice(1)
      : afterCursor;

  const isDirectory = item.label.endsWith("/");
  const suffix = isDirectory ? "" : " ";
  const newValue = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
  const hasTrailingQuote = item.value.endsWith('"');
  const cursorOffset =
    isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

  return {
    value: newValue,
    cursorPosition: beforePrefix.length + cursorOffset + suffix.length,
  };
}

export class FileAutocompleteProvider {
  private basePath: string;
  private fdPath: string | null;

  constructor(basePath: string = process.cwd(), fdPath: string | null = null) {
    this.basePath = basePath;
    this.fdPath = fdPath;
  }

  async getSuggestions(
    currentInput: string,
    cursorPosition: number,
    options: { signal: AbortSignal },
  ): Promise<FileAutocompleteSuggestions | null> {
    const textBeforeCursor = currentInput.slice(0, cursorPosition);
    const atPrefix = this.extractAtPrefix(textBeforeCursor);
    if (atPrefix) {
      const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
      const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
        isQuotedPrefix,
        signal: options.signal,
      });
      if (suggestions.length === 0) return null;

      return {
        items: suggestions,
        prefix: atPrefix,
      };
    }

    return null;
  }

  private extractAtPrefix(text: string): string | null {
    const quotedPrefix = extractQuotedPrefix(text);
    if (quotedPrefix?.startsWith('@"')) {
      return quotedPrefix;
    }

    const lastDelimiterIndex = findLastDelimiter(text);
    const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

    if (text[tokenStart] === "@") {
      return text.slice(tokenStart);
    }

    return null;
  }

  private expandHomePath(path: string): string {
    if (path.startsWith("~/")) {
      const expandedPath = join(homedir(), path.slice(2));
      return path.endsWith("/") && !expandedPath.endsWith("/")
        ? `${expandedPath}/`
        : expandedPath;
    } else if (path === "~") {
      return homedir();
    }
    return path;
  }

  private resolveScopedFuzzyQuery(rawQuery: string): {
    baseDir: string;
    query: string;
    displayBase: string;
  } | null {
    const normalizedQuery = toDisplayPath(rawQuery);
    const slashIndex = normalizedQuery.lastIndexOf("/");
    if (slashIndex === -1) {
      return null;
    }

    const displayBase = normalizedQuery.slice(0, slashIndex + 1);
    const query = normalizedQuery.slice(slashIndex + 1);

    let baseDir: string;
    if (displayBase.startsWith("~/")) {
      baseDir = this.expandHomePath(displayBase);
    } else if (displayBase.startsWith("/")) {
      baseDir = displayBase;
    } else {
      baseDir = join(this.basePath, displayBase);
    }

    try {
      if (!statSync(baseDir).isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    return { baseDir, query, displayBase };
  }

  private scopedPathForDisplay(
    displayBase: string,
    relativePath: string,
  ): string {
    const normalizedRelativePath = toDisplayPath(relativePath);
    if (displayBase === "/") {
      return `/${normalizedRelativePath}`;
    }
    return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
  }

  private scoreEntry(
    filePath: string,
    query: string,
    isDirectory: boolean,
  ): number {
    const fileName = basename(filePath);
    const lowerFileName = fileName.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let score = 0;

    if (lowerFileName === lowerQuery) score = 100;
    else if (lowerFileName.startsWith(lowerQuery)) score = 80;
    else if (lowerFileName.includes(lowerQuery)) score = 50;
    else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

    if (isDirectory && score > 0) score += 10;

    return score;
  }

  private async getFuzzyFileSuggestions(
    query: string,
    options: { isQuotedPrefix: boolean; signal: AbortSignal },
  ): Promise<FileAutocompleteItem[]> {
    if (!this.fdPath || options.signal.aborted) {
      return [];
    }

    try {
      const scopedQuery = this.resolveScopedFuzzyQuery(query);
      const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
      const fdQuery = scopedQuery?.query ?? query;
      const entries = await walkDirectoryWithFd(
        fdBaseDir,
        this.fdPath,
        fdQuery,
        100,
        options.signal,
      );
      if (options.signal.aborted) {
        return [];
      }

      const scoredEntries = entries
        .map((entry) => ({
          ...entry,
          score: fdQuery
            ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory)
            : 1,
        }))
        .filter((entry) => entry.score > 0);

      scoredEntries.sort((a, b) => b.score - a.score);
      const topEntries = scoredEntries.slice(0, 20);

      const suggestions: FileAutocompleteItem[] = [];
      for (const { path: entryPath, isDirectory } of topEntries) {
        const pathWithoutSlash = isDirectory
          ? entryPath.slice(0, -1)
          : entryPath;
        const displayPath = scopedQuery
          ? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
          : pathWithoutSlash;
        const entryName = basename(pathWithoutSlash);
        const completionPath = isDirectory ? `${displayPath}/` : displayPath;
        const value = buildCompletionValue(completionPath, {
          isDirectory,
          isAtPrefix: true,
          isQuotedPrefix: options.isQuotedPrefix,
        });

        suggestions.push({
          value,
          label: entryName + (isDirectory ? "/" : ""),
          description: displayPath,
        });
      }

      return suggestions;
    } catch {
      return [];
    }
  }
}
