import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

const FD_TOOLS_DIR = join(homedir(), ".letta", "bin");
const FD_BINARY_NAME = platform() === "win32" ? "fd.exe" : "fd";
const FD_LOCAL_PATH = join(FD_TOOLS_DIR, FD_BINARY_NAME);
const FD_DOWNLOAD_REPO = "sharkdp/fd";
const FD_DOWNLOAD_TIMEOUT_MS = 120_000;
const FD_NETWORK_TIMEOUT_MS = 10_000;

let cachedFdPath: string | null | undefined;
let pendingFdPath: Promise<string | null> | null = null;

function commandExists(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "pipe" });
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

function getFdAssetName(version: string): string | null {
  const plat = platform();
  const architecture = arch();
  const archStr = architecture === "arm64" ? "aarch64" : "x86_64";

  if (plat === "darwin") {
    return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
  }
  if (plat === "linux") {
    return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
  }
  if (plat === "win32") {
    return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
  }
  return null;
}

async function getLatestFdVersion(): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${FD_DOWNLOAD_REPO}/releases/latest`,
    {
      headers: { "User-Agent": "letta-code" },
      signal: AbortSignal.timeout(FD_NETWORK_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = (await response.json()) as { tag_name: string };
  return data.tag_name.replace(/^v/, "");
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FD_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to download fd: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Failed to download fd: empty response body");
  }

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination),
  );
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error?.message) {
    return result.error.message;
  }
  const stderr = result.stderr?.toString().trim();
  if (stderr) {
    return stderr;
  }
  const stdout = result.stdout?.toString().trim();
  if (stdout) {
    return stdout;
  }
  return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) {
    return null;
  }
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string): void {
  const failure = runExtractionCommand("tar", [
    "xzf",
    archivePath,
    "-C",
    extractDir,
  ]);
  if (failure) {
    throw new Error(`Failed to extract fd: ${failure}`);
  }
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, "System32", "tar.exe");
    if (existsSync(systemTar)) {
      return systemTar;
    }
  }
  return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string): void {
  const failures: string[] = [];

  if (platform() === "win32") {
    const tarFailure = runExtractionCommand(getWindowsTarCommand(), [
      "xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    if (!tarFailure) return;
    failures.push(tarFailure);

    const script =
      "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      archivePath,
      extractDir,
    ]);
    if (!powershellFailure) return;
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand("unzip", [
      "-q",
      archivePath,
      "-d",
      extractDir,
    ]);
    if (!unzipFailure) return;
    failures.push(unzipFailure);

    const tarFailure = runExtractionCommand("tar", [
      "xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }

  throw new Error(`Failed to extract fd: ${failures.join("; ")}`);
}

function findBinaryRecursively(
  rootDir: string,
  binaryName: string,
): string | null {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  return null;
}

async function downloadFd(): Promise<string> {
  let version = await getLatestFdVersion();
  if (platform() === "darwin" && arch() === "x64") {
    version = "10.3.0";
  }

  const assetName = getFdAssetName(version);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${platform()}/${arch()}`);
  }

  mkdirSync(FD_TOOLS_DIR, { recursive: true });
  const archivePath = join(FD_TOOLS_DIR, assetName);
  const extractDir = join(
    FD_TOOLS_DIR,
    `extract_tmp_fd_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });

  try {
    await downloadFile(
      `https://github.com/${FD_DOWNLOAD_REPO}/releases/download/v${version}/${assetName}`,
      archivePath,
    );

    if (assetName.endsWith(".tar.gz")) {
      extractTarGzArchive(archivePath, extractDir);
    } else if (assetName.endsWith(".zip")) {
      extractZipArchive(archivePath, extractDir);
    } else {
      throw new Error(`Unsupported fd archive format: ${assetName}`);
    }

    const extractedBinary = findBinaryRecursively(extractDir, FD_BINARY_NAME);
    if (!extractedBinary) {
      throw new Error(`fd binary not found in archive: ${assetName}`);
    }

    renameSync(extractedBinary, FD_LOCAL_PATH);
    if (platform() !== "win32") {
      chmodSync(FD_LOCAL_PATH, 0o755);
    }
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  return FD_LOCAL_PATH;
}

export function resolveFdPath(): string | null {
  if (cachedFdPath !== undefined) {
    return cachedFdPath;
  }

  if (existsSync(FD_LOCAL_PATH)) {
    cachedFdPath = FD_LOCAL_PATH;
    return cachedFdPath;
  }

  for (const binaryName of ["fd", "fdfind"]) {
    if (commandExists(binaryName)) {
      cachedFdPath = binaryName;
      return cachedFdPath;
    }
  }

  cachedFdPath = null;
  return null;
}

export async function ensureFdPath(): Promise<string | null> {
  const existingPath = resolveFdPath();
  if (existingPath) {
    return existingPath;
  }

  if (pendingFdPath) {
    return pendingFdPath;
  }

  pendingFdPath = downloadFd()
    .then((downloadedPath) => {
      cachedFdPath = downloadedPath;
      return downloadedPath;
    })
    .catch(() => {
      cachedFdPath = null;
      return null;
    })
    .finally(() => {
      pendingFdPath = null;
    });

  return pendingFdPath;
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
