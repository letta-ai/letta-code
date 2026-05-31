import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { readLettaIgnorePatterns } from "./ignored-directories";

const DEFAULT_MAX_RESULTS = 100;

const PROTECTED_HOME_NAMES = new Set([
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
]);

const ALWAYS_EXCLUDED_RELATIVE_PATHS = [".letta/worktrees"];

export interface FileAutocompleteMatch {
  path: string;
  type: "file" | "dir" | "url";
}

interface SearchFileAutocompleteOptions {
  cwd?: string;
  homeDirectory?: string;
  maxResults?: number;
  signal?: AbortSignal;
}

interface IgnoreMatchers {
  nameMatchers: picomatch.Matcher[];
  pathMatchers: picomatch.Matcher[];
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function getRipgrepPath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    return rgPackage.rgPath;
  } catch (_error) {
    return "rg";
  }
}

const rgPath = getRipgrepPath();

function normalizePathForDisplay(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isAlwaysExcludedRelativePath(relativePath: string): boolean {
  const normalized = normalizePathForDisplay(relativePath);
  return ALWAYS_EXCLUDED_RELATIVE_PATHS.some(
    (excluded) =>
      normalized === excluded || normalized.startsWith(`${excluded}/`),
  );
}

function isProtectedHomePath(
  candidate: string,
  homeDirectory: string,
): boolean {
  if (!isWithinOrEqual(homeDirectory, candidate)) return false;
  const relativeToHome = normalizePathForDisplay(
    path.relative(homeDirectory, candidate),
  );
  const [firstSegment] = relativeToHome.split("/");
  return !!firstSegment && PROTECTED_HOME_NAMES.has(firstSegment);
}

function buildIgnoreMatchers(cwd: string): IgnoreMatchers {
  const nameMatchers: picomatch.Matcher[] = [];
  const pathMatchers: picomatch.Matcher[] = [];

  for (const rawPattern of readLettaIgnorePatterns(cwd)) {
    const pattern = rawPattern.replace(/\/$/, "");
    if (!pattern) continue;

    if (pattern.includes("/")) {
      pathMatchers.push(picomatch(pattern, { dot: true }));
    } else {
      nameMatchers.push(picomatch(pattern, { dot: true, nocase: true }));
    }
  }

  return { nameMatchers, pathMatchers };
}

function shouldExcludeCandidate(params: {
  absolutePath: string;
  cwd: string;
  homeDirectory: string;
  ignoreMatchers: IgnoreMatchers;
}): boolean {
  const { absolutePath, cwd, homeDirectory, ignoreMatchers } = params;

  if (isProtectedHomePath(absolutePath, homeDirectory)) return true;

  const relativeToCwd = path.relative(cwd, absolutePath);
  if (
    relativeToCwd &&
    !relativeToCwd.startsWith("..") &&
    !path.isAbsolute(relativeToCwd) &&
    isAlwaysExcludedRelativePath(relativeToCwd)
  ) {
    return true;
  }

  if (
    relativeToCwd &&
    !relativeToCwd.startsWith("..") &&
    !path.isAbsolute(relativeToCwd)
  ) {
    const normalizedRelative = normalizePathForDisplay(relativeToCwd);
    const segments = normalizedRelative.split("/").filter(Boolean);
    if (
      ignoreMatchers.nameMatchers.some((matcher) =>
        segments.some((segment) => matcher(segment)),
      )
    ) {
      return true;
    }

    if (
      ignoreMatchers.pathMatchers.some((matcher) => matcher(normalizedRelative))
    ) {
      return true;
    }
  } else {
    const basename = path.basename(absolutePath);
    if (ignoreMatchers.nameMatchers.some((matcher) => matcher(basename))) {
      return true;
    }
  }

  return false;
}

function formatMatchPath(cwd: string, absolutePath: string): string {
  const relativeToCwd = path.relative(cwd, absolutePath);
  if (
    relativeToCwd &&
    !relativeToCwd.startsWith("..") &&
    !path.isAbsolute(relativeToCwd)
  ) {
    return normalizePathForDisplay(relativeToCwd);
  }
  if (relativeToCwd === "") return ".";
  return normalizePathForDisplay(absolutePath);
}

function sortMatches(
  matches: FileAutocompleteMatch[],
): FileAutocompleteMatch[] {
  return matches.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.path.localeCompare(b.path);
  });
}

function expandTilde(query: string, homeDirectory: string): string {
  if (query === "~") return homeDirectory;
  if (query.startsWith("~/") || query.startsWith("~\\")) {
    return path.join(homeDirectory, query.slice(2));
  }
  return query;
}

function hasPathSeparator(query: string): boolean {
  return query.includes("/") || query.includes("\\");
}

function isPathLikeQuery(query: string): boolean {
  if (!query) return false;
  return (
    hasPathSeparator(query) ||
    query.startsWith(".") ||
    query.startsWith("~") ||
    path.isAbsolute(query)
  );
}

function resolvePathQuery(
  cwd: string,
  homeDirectory: string,
  query: string,
): { directory: string; pattern: string } {
  const expanded = expandTilde(query, homeDirectory);
  const absoluteQuery = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(cwd, expanded);
  const endsWithSeparator = /[/\\]$/.test(query);

  if (endsWithSeparator) {
    return { directory: absoluteQuery, pattern: "" };
  }

  return {
    directory: path.dirname(absoluteQuery),
    pattern: path.basename(absoluteQuery),
  };
}

async function searchShallow(params: {
  directory: string;
  pattern: string;
  cwd: string;
  homeDirectory: string;
  maxResults: number;
  ignoreMatchers: IgnoreMatchers;
}): Promise<FileAutocompleteMatch[]> {
  const { directory, pattern, cwd, homeDirectory, maxResults, ignoreMatchers } =
    params;
  if (isProtectedHomePath(directory, homeDirectory)) return [];

  let entries: DirectoryEntry[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const lowerPattern = pattern.toLowerCase();
  const results: FileAutocompleteMatch[] = [];

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (lowerPattern && !entry.name.toLowerCase().includes(lowerPattern)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (
      shouldExcludeCandidate({
        absolutePath,
        cwd,
        homeDirectory,
        ignoreMatchers,
      })
    ) {
      continue;
    }

    results.push({
      path: formatMatchPath(cwd, absolutePath),
      type: entry.isDirectory() ? "dir" : "file",
    });
  }

  return sortMatches(results);
}

function buildRipgrepArgs(searchRoot: string, homeDirectory: string): string[] {
  const args = [
    "--files",
    "--hidden",
    "--no-messages",
    "--color",
    "never",
    "--glob",
    "!.git",
    "--glob",
    "!.git/**",
    "--glob",
    "!.letta/worktrees",
    "--glob",
    "!.letta/worktrees/**",
  ];

  if (isWithinOrEqual(homeDirectory, searchRoot)) {
    const relativeToHome = path.relative(homeDirectory, searchRoot);
    if (relativeToHome === "") {
      for (const protectedName of PROTECTED_HOME_NAMES) {
        args.push("--glob", `!${protectedName}`);
        args.push("--glob", `!${protectedName}/**`);
      }
    }
  }

  return args;
}

async function searchWithRipgrep(params: {
  query: string;
  cwd: string;
  homeDirectory: string;
  maxResults: number;
  ignoreMatchers: IgnoreMatchers;
  signal?: AbortSignal;
}): Promise<FileAutocompleteMatch[]> {
  const { query, cwd, homeDirectory, maxResults, ignoreMatchers, signal } =
    params;
  if (signal?.aborted) return [];
  if (isProtectedHomePath(cwd, homeDirectory)) return [];

  const lowerQuery = query.toLowerCase();
  const seen = new Set<string>();
  const matches: FileAutocompleteMatch[] = [];

  function addMatch(absolutePath: string, type: "file" | "dir") {
    if (matches.length >= maxResults) return;
    if (
      shouldExcludeCandidate({
        absolutePath,
        cwd,
        homeDirectory,
        ignoreMatchers,
      })
    ) {
      return;
    }

    const displayPath = formatMatchPath(cwd, absolutePath);
    if (!displayPath.toLowerCase().includes(lowerQuery)) return;
    const key = `${type}:${displayPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ path: displayPath, type });
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuffer = "";
    let hitLimit = false;

    function settle() {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(sortMatches(matches).slice(0, maxResults));
    }

    function abort() {
      child.kill("SIGTERM");
      matches.length = 0;
      settle();
    }

    function handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed || hitLimit) return;

      const absolutePath = path.resolve(cwd, trimmed);
      const parentDir = path.dirname(absolutePath);
      if (parentDir !== cwd) {
        addMatch(parentDir, "dir");
      }
      addMatch(absolutePath, "file");

      if (matches.length >= maxResults) {
        hitLimit = true;
        child.kill("SIGTERM");
        settle();
      }
    }

    const child = spawn(rgPath, buildRipgrepArgs(cwd, homeDirectory), {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.on("error", () => {
      settle();
    });

    child.on("close", () => {
      if (stdoutBuffer) {
        handleLine(stdoutBuffer);
      }
      settle();
    });
  });
}

/**
 * On-demand, path-only search for TUI @ autocomplete.
 *
 * Empty/path-like queries are resolved with a one-level directory listing.
 * Fuzzy non-empty queries shell out to bundled ripgrep's `rg --files` and kill
 * the subprocess as soon as enough matches are collected. No persistent cache or
 * file-content reads are used.
 */
export async function searchFileAutocomplete(
  query: string,
  options: SearchFileAutocompleteOptions = {},
): Promise<FileAutocompleteMatch[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDirectory = path.resolve(options.homeDirectory ?? homedir());
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const ignoreMatchers = buildIgnoreMatchers(cwd);

  if (query.length === 0) {
    return searchShallow({
      directory: cwd,
      pattern: "",
      cwd,
      homeDirectory,
      maxResults,
      ignoreMatchers,
    });
  }

  if (isPathLikeQuery(query)) {
    const { directory, pattern } = resolvePathQuery(cwd, homeDirectory, query);
    return searchShallow({
      directory,
      pattern,
      cwd,
      homeDirectory,
      maxResults,
      ignoreMatchers,
    });
  }

  // If the process was launched from the user's home directory, do not turn a
  // fuzzy @ query into a recursive home crawl. Keep it to a shallow listing
  // until the user explicitly navigates into a subdirectory (e.g. @dev/...).
  if (path.resolve(cwd) === homeDirectory) {
    return searchShallow({
      directory: cwd,
      pattern: query,
      cwd,
      homeDirectory,
      maxResults,
      ignoreMatchers,
    });
  }

  return searchWithRipgrep({
    query,
    cwd,
    homeDirectory,
    maxResults,
    ignoreMatchers,
    signal: options.signal,
  });
}
