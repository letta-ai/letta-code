import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import type WebSocket from "ws";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { readUtf8TextStrict, writeUtf8Text } from "@/utils/text-files";
import { runGrepInFiles } from "./grep-in-files";
import {
  isEditFileCommand,
  isFileOpsCommand,
  isGetTreeCommand,
  isGrepInFilesCommand,
  isListInDirectoryCommand,
  isReadFileCommand,
  isSearchFilesCommand,
  isUnwatchFileCommand,
  isWatchFileCommand,
  isWriteFileCommand,
} from "./protocol-inbound";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

type RunDetachedListenerTask = (
  commandName: string,
  task: () => Promise<void>,
) => void;

function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

/** File/directory names filtered from directory listings (OS/VCS noise). */
const DIR_LISTING_IGNORED_NAMES = new Set([".DS_Store", ".git", "Thumbs.db"]);

/** Directories skipped by recursive listener filesystem operations. */
const RECURSIVE_IGNORED_NAMES = new Set([
  ...DIR_LISTING_IGNORED_NAMES,
  ".cache",
  ".letta",
  ".next",
  ".nuxt",
  ".tox",
  ".venv",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
  "__pycache__",
]);

/**
 * Home-directory children that commonly trigger macOS TCC prompts. When the
 * listener is scoped to the user's home directory, recursive operations skip
 * these before stat/readdir. This mirrors OpenCode's global-home guardrail.
 */
const PROTECTED_HOME_NAMES = new Set([
  "applications",
  "desktop",
  "documents",
  "downloads",
  "library",
  "movies",
  "music",
  "pictures",
  "public",
]);

const MAX_SEARCH_VISITED_ENTRIES = 50_000;
const MAX_TREE_ENTRIES = 5_000;
const MAX_SEARCH_RESULTS = 200;

interface IgnoreConfig {
  nameMatchers: picomatch.Matcher[];
  pathMatchers: picomatch.Matcher[];
}

const ignoreConfigCache = new Map<string, IgnoreConfig>();

interface DirListing {
  folders: string[];
  files: string[];
}

interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeAbsPath(value: string): string {
  return path.resolve(value);
}

function isWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function getHomeDirectory(): string {
  return normalizeAbsPath(process.env.HOME || homedir());
}

function isHomeDirectory(absPath: string): boolean {
  return normalizeAbsPath(absPath) === getHomeDirectory();
}

function getProtectedHomeSegment(absPath: string): string | null {
  const home = getHomeDirectory();
  const target = normalizeAbsPath(absPath);
  if (!isWithinOrEqual(home, target)) return null;
  const relative = path.relative(home, target);
  if (!relative) return null;
  const [firstSegment] = relative.split(path.sep);
  const normalized = firstSegment?.toLowerCase();
  return normalized && PROTECTED_HOME_NAMES.has(normalized) ? normalized : null;
}

function shouldSkipProtectedHomePath(root: string, absPath: string): boolean {
  const protectedSegment = getProtectedHomeSegment(absPath);
  if (!protectedSegment) return false;

  // If the user explicitly scoped the operation inside a protected home
  // directory (for example ~/Documents/my-project), allow that workspace.
  // The guard is intended to stop broad traversal from $HOME into protected
  // directories, not to make explicitly selected projects disappear.
  return getProtectedHomeSegment(root) !== protectedSegment;
}

function parseLettaIgnore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    );
}

async function getIgnoreConfig(root: string): Promise<IgnoreConfig> {
  const absRoot = normalizeAbsPath(root);
  const cached = ignoreConfigCache.get(absRoot);
  if (cached) return cached;

  let patterns: string[] = [];
  try {
    const content = await readFile(
      path.join(absRoot, ".letta", ".lettaignore"),
      "utf-8",
    );
    patterns = parseLettaIgnore(content);
  } catch {
    patterns = [];
  }

  const config: IgnoreConfig = { nameMatchers: [], pathMatchers: [] };
  for (const raw of patterns) {
    const normalized = raw.replace(/\/$/, "");
    if (!normalized) continue;
    if (normalized.includes("/")) {
      config.pathMatchers.push(picomatch(normalized, { dot: true }));
    } else {
      config.nameMatchers.push(
        picomatch(normalized, { dot: true, nocase: true }),
      );
    }
  }

  ignoreConfigCache.set(absRoot, config);
  return config;
}

function isAlwaysExcludedRelativePath(relativePath: string): boolean {
  return (
    relativePath === ".letta/worktrees" ||
    relativePath.startsWith(".letta/worktrees/")
  );
}

async function shouldSkipEntry(options: {
  root: string;
  absPath: string;
  name: string;
  isDirectory: boolean;
  recursive: boolean;
}): Promise<boolean> {
  const { root, absPath, name, isDirectory, recursive } = options;
  const relativePath = toPosixPath(
    path.relative(normalizeAbsPath(root), absPath),
  );

  if (DIR_LISTING_IGNORED_NAMES.has(name)) return true;
  if (isAlwaysExcludedRelativePath(relativePath)) return true;
  if (recursive && isDirectory && RECURSIVE_IGNORED_NAMES.has(name))
    return true;
  if (shouldSkipProtectedHomePath(root, absPath)) return true;

  const { nameMatchers, pathMatchers } = await getIgnoreConfig(root);
  if (nameMatchers.some((matcher) => matcher(name))) return true;
  if (relativePath && pathMatchers.some((matcher) => matcher(relativePath))) {
    return true;
  }

  return false;
}

/**
 * List a single directory directly via readdir. This intentionally does not
 * warm or consult the old recursive file index; desktop file tree requests are
 * already bounded/paginated by the caller and should stay path-only.
 */
async function listDirectoryDirect(
  absDir: string,
  root: string,
  includeFiles: boolean,
  options: { recursive?: boolean } = {},
): Promise<DirListing> {
  if (shouldSkipProtectedHomePath(root, absDir)) {
    return { folders: [], files: [] };
  }

  const entries = await readdir(absDir, { withFileTypes: true });
  const folders: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const absPath = path.join(absDir, entry.name);
    if (
      await shouldSkipEntry({
        root,
        absPath,
        name: entry.name,
        isDirectory: entry.isDirectory(),
        recursive: options.recursive ?? false,
      })
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      folders.push(entry.name);
    } else if (includeFiles) {
      files.push(entry.name);
    }
  }

  return {
    folders: folders.sort((a, b) => a.localeCompare(b)),
    files: includeFiles ? files.sort((a, b) => a.localeCompare(b)) : [],
  };
}

async function searchFilesDirect(options: {
  root: string;
  query: string;
  maxResults: number;
}): Promise<TreeEntry[]> {
  const root = normalizeAbsPath(options.root);
  const query = options.query.trim().toLowerCase();
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults, MAX_SEARCH_RESULTS),
  );

  const addIfMatch = (results: TreeEntry[], entry: TreeEntry): boolean => {
    if (!query || entry.path.toLowerCase().includes(query)) {
      results.push(entry);
      return results.length >= maxResults;
    }
    return false;
  };

  const results: TreeEntry[] = [];

  // Home/global mode is intentionally shallow to avoid recursively touching
  // protected user directories. Users can scope cwd to a safe subdirectory
  // (for example ~/dev/project) for deep quick-open/search.
  if (isHomeDirectory(root)) {
    const listing = await listDirectoryDirect(root, root, true, {
      recursive: false,
    });
    for (const folder of listing.folders) {
      if (addIfMatch(results, { path: folder, type: "dir" })) return results;
    }
    for (const file of listing.files) {
      if (addIfMatch(results, { path: file, type: "file" })) return results;
    }
    return results;
  }

  const queue: string[] = [root];
  let qi = 0;
  let visited = 0;

  while (qi < queue.length && visited < MAX_SEARCH_VISITED_ENTRIES) {
    const dir = queue[qi++];
    if (!dir) break;

    let listing: DirListing;
    try {
      listing = await listDirectoryDirect(dir, root, true, { recursive: true });
    } catch {
      continue;
    }

    for (const folder of listing.folders) {
      visited += 1;
      const absPath = path.join(dir, folder);
      const relPath = toPosixPath(path.relative(root, absPath));
      if (addIfMatch(results, { path: relPath, type: "dir" })) return results;
      queue.push(absPath);
    }

    for (const file of listing.files) {
      visited += 1;
      const relPath = toPosixPath(path.relative(root, path.join(dir, file)));
      if (addIfMatch(results, { path: relPath, type: "file" })) return results;
    }
  }

  return results;
}

async function getTreeDirect(options: {
  root: string;
  depth: number;
}): Promise<{ entries: TreeEntry[]; hasMoreDepth: boolean }> {
  const root = normalizeAbsPath(options.root);
  const maxDepth = Math.max(0, options.depth);
  const entries: TreeEntry[] = [];
  let hasMoreDepth = false;

  if (maxDepth === 0 || shouldSkipProtectedHomePath(root, root)) {
    return { entries, hasMoreDepth };
  }

  const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
    { absDir: root, relDir: "", depth: 0 },
  ];
  let qi = 0;

  while (qi < queue.length) {
    const item = queue[qi++];
    if (!item) break;
    if (item.depth >= maxDepth) {
      if (item.relDir !== "") hasMoreDepth = true;
      continue;
    }

    let listing: DirListing;
    try {
      listing = await listDirectoryDirect(item.absDir, root, true, {
        recursive: true,
      });
    } catch {
      continue;
    }

    for (const folder of listing.folders) {
      const entryRel = item.relDir === "" ? folder : `${item.relDir}/${folder}`;
      entries.push({ path: entryRel, type: "dir" });
      if (entries.length >= MAX_TREE_ENTRIES) {
        hasMoreDepth = true;
        return { entries, hasMoreDepth };
      }
      queue.push({
        absDir: path.join(item.absDir, folder),
        relDir: entryRel,
        depth: item.depth + 1,
      });
    }

    for (const file of listing.files) {
      const entryRel = item.relDir === "" ? file : `${item.relDir}/${file}`;
      entries.push({ path: entryRel, type: "file" });
      if (entries.length >= MAX_TREE_ENTRIES) {
        hasMoreDepth = true;
        return { entries, hasMoreDepth };
      }
    }
  }

  return { entries, hasMoreDepth };
}

export function createFileCommandSession(params: {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
}): {
  handle: (parsed: unknown) => boolean;
  dispose: () => void;
} {
  const { socket, safeSocketSend, runDetachedListenerTask } = params;

  // File watchers are keyed by absolute path and ref-counted so multiple
  // windows watching the same file share one fs.watch() handle.
  const fileWatchers = new Map<
    string,
    { watcher: import("node:fs").FSWatcher; refCount: number }
  >();
  // Debounce timers for fs.watch events; macOS/FSEvents can fire multiple
  // rapid events for a single save.
  const watchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Paths where unwatch_file arrived while the watch_file async task was still
  // in flight. The task checks this set after its await and bails if present.
  const cancelledWatches = new Set<string>();

  const dispose = (): void => {
    for (const { watcher } of fileWatchers.values()) {
      watcher.close();
    }
    fileWatchers.clear();

    for (const timer of watchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    watchDebounceTimers.clear();
    cancelledWatches.clear();
  };

  const handle = (parsed: unknown): boolean => {
    // File search (no runtime scope required)
    if (isSearchFilesCommand(parsed)) {
      runDetachedListenerTask("search_files", async () => {
        try {
          const files = await searchFilesDirect({
            root: parsed.cwd ?? process.cwd(),
            query: parsed.query,
            maxResults: parsed.max_results ?? 5,
          });
          safeSocketSend(
            socket,
            {
              type: "search_files_response",
              request_id: parsed.request_id,
              files,
              success: true,
            },
            "listener_search_files_send_failed",
            "listener_search_files",
          );
        } catch (error) {
          trackListenerError(
            "listener_search_files_failed",
            error,
            "listener_file_search",
          );
          safeSocketSend(
            socket,
            {
              type: "search_files_response",
              request_id: parsed.request_id,
              files: [],
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to search files",
            },
            "listener_search_files_send_failed",
            "listener_search_files",
          );
        }
      });
      return true;
    }

    // Find-in-files content search (no runtime scope required)
    if (isGrepInFilesCommand(parsed)) {
      runDetachedListenerTask("grep_in_files", async () => {
        try {
          const searchRoot = parsed.cwd ?? process.cwd();
          if (isHomeDirectory(searchRoot)) {
            safeSocketSend(
              socket,
              {
                type: "grep_in_files_response",
                request_id: parsed.request_id,
                success: true,
                matches: [],
                total_matches: 0,
                total_files: 0,
                truncated: false,
              },
              "listener_grep_in_files_send_failed",
              "listener_grep_in_files",
            );
            return;
          }

          const { matches, totalMatches, totalFiles, truncated } =
            await runGrepInFiles({
              searchRoot,
              query: parsed.query,
              isRegex: parsed.is_regex ?? false,
              caseSensitive: parsed.case_sensitive ?? false,
              wholeWord: parsed.whole_word ?? false,
              glob: parsed.glob,
              maxResults: parsed.max_results ?? 500,
              contextLines: parsed.context_lines ?? 2,
            });

          safeSocketSend(
            socket,
            {
              type: "grep_in_files_response",
              request_id: parsed.request_id,
              success: true,
              matches,
              total_matches: totalMatches,
              total_files: totalFiles,
              truncated,
            },
            "listener_grep_in_files_send_failed",
            "listener_grep_in_files",
          );
        } catch (error) {
          trackListenerError(
            "listener_grep_in_files_failed",
            error,
            "listener_grep_in_files",
          );
          safeSocketSend(
            socket,
            {
              type: "grep_in_files_response",
              request_id: parsed.request_id,
              success: false,
              matches: [],
              total_matches: 0,
              total_files: 0,
              truncated: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to search file contents",
            },
            "listener_grep_in_files_send_failed",
            "listener_grep_in_files",
          );
        }
      });
      return true;
    }

    // Directory listing (no runtime scope required)
    if (isListInDirectoryCommand(parsed)) {
      console.log(
        `[Listen] Received list_in_directory command: path=${parsed.path}`,
      );
      runDetachedListenerTask("list_in_directory", async () => {
        try {
          console.log(`[Listen] Reading directory: ${parsed.path}`);
          const { folders: allFolders, files: allFiles } =
            await listDirectoryDirect(
              parsed.path,
              parsed.path,
              !!parsed.include_files,
            );

          const total = allFolders.length + allFiles.length;
          const offset = parsed.offset ?? 0;
          const limit = parsed.limit ?? total;

          // Paginate over the combined [folders, files] list
          const combined = [...allFolders, ...allFiles];
          const page = combined.slice(offset, offset + limit);
          const folderSet = new Set(allFolders);
          const folders = page.filter((name) => folderSet.has(name));
          const files = page.filter((name) => !folderSet.has(name));

          const response: Record<string, unknown> = {
            type: "list_in_directory_response",
            path: parsed.path,
            folders,
            hasMore: offset + limit < total,
            total,
            success: true,
            ...(parsed.request_id ? { request_id: parsed.request_id } : {}),
          };
          if (parsed.include_files) {
            response.files = files;
          }
          console.log(
            `[Listen] Sending list_in_directory_response: ${folders.length} folders, ${files?.length ?? 0} files`,
          );
          safeSocketSend(
            socket,
            response,
            "listener_list_directory_send_failed",
            "listener_list_in_directory",
          );
        } catch (err) {
          trackListenerError(
            "listener_list_directory_failed",
            err,
            "listener_file_browser",
          );
          console.error(
            `[Listen] list_in_directory error: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
          safeSocketSend(
            socket,
            {
              type: "list_in_directory_response",
              path: parsed.path,
              folders: [],
              hasMore: false,
              success: false,
              error:
                err instanceof Error ? err.message : "Failed to list directory",
              ...(parsed.request_id ? { request_id: parsed.request_id } : {}),
            },
            "listener_list_directory_send_failed",
            "listener_list_in_directory",
          );
        }
      });
      return true;
    }

    // Depth-limited subtree fetch (no runtime scope required)
    if (isGetTreeCommand(parsed)) {
      console.log(
        `[Listen] Received get_tree command: path=${parsed.path}, depth=${parsed.depth}`,
      );
      runDetachedListenerTask("get_tree", async () => {
        try {
          const { entries: results, hasMoreDepth } = await getTreeDirect({
            root: parsed.path,
            depth: parsed.depth,
          });

          console.log(
            `[Listen] Sending get_tree_response: ${results.length} entries, has_more_depth=${hasMoreDepth}`,
          );
          safeSocketSend(
            socket,
            {
              type: "get_tree_response",
              path: parsed.path,
              request_id: parsed.request_id,
              entries: results,
              has_more_depth: hasMoreDepth,
              success: true,
            },
            "listener_get_tree_send_failed",
            "listener_get_tree",
          );
        } catch (err) {
          trackListenerError(
            "listener_get_tree_failed",
            err,
            "listener_file_browser",
          );
          console.error(
            `[Listen] get_tree error: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
          safeSocketSend(
            socket,
            {
              type: "get_tree_response",
              path: parsed.path,
              request_id: parsed.request_id,
              entries: [],
              has_more_depth: false,
              success: false,
              error: err instanceof Error ? err.message : "Failed to get tree",
            },
            "listener_get_tree_send_failed",
            "listener_get_tree",
          );
        }
      });
      return true;
    }

    // File reading (no runtime scope required)
    if (isReadFileCommand(parsed)) {
      console.log(
        `[Listen] Received read_file command: path=${parsed.path}, request_id=${parsed.request_id}`,
      );
      runDetachedListenerTask("read_file", async () => {
        try {
          const content = await readUtf8TextStrict(parsed.path);
          console.log(
            `[Listen] read_file success: ${parsed.path} (${content.length} bytes)`,
          );
          safeSocketSend(
            socket,
            {
              type: "read_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              content,
              success: true,
            },
            "listener_read_file_send_failed",
            "listener_read_file",
          );
        } catch (err) {
          trackListenerError(
            "listener_read_file_failed",
            err,
            "listener_file_read",
          );
          console.error(
            `[Listen] read_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
          safeSocketSend(
            socket,
            {
              type: "read_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              content: null,
              success: false,
              error: err instanceof Error ? err.message : "Failed to read file",
            },
            "listener_read_file_send_failed",
            "listener_read_file",
          );
        }
      });
      return true;
    }

    // File writing (no runtime scope required)
    if (isWriteFileCommand(parsed)) {
      console.log(
        `[Listen] Received write_file command: path=${parsed.path}, request_id=${parsed.request_id}`,
      );
      runDetachedListenerTask("write_file", async () => {
        try {
          const { edit } = await import("@/tools/impl/edit");
          const { write } = await import("@/tools/impl/write");

          // Read current content so we can use edit for an atomic
          // read-modify-write that goes through the same code path as
          // the agent's Edit tool (CRLF normalisation, rich errors, etc.).
          let currentContent: string | null = null;
          try {
            currentContent = await readUtf8TextStrict(parsed.path);
          } catch (readErr) {
            const e = readErr as NodeJS.ErrnoException;
            if (e.code !== "ENOENT") throw readErr;
            // ENOENT -- new file, fall through to write below
          }

          if (currentContent === null) {
            // New file -- use write so directories are created as needed.
            await write({ file_path: parsed.path, content: parsed.content });
          } else {
            // Existing file -- use edit for a full-content replacement.
            // Normalise line endings before comparing to avoid a spurious
            // "no changes" error when the only difference is CRLF vs LF.
            const normalizedCurrent = currentContent.replace(/\r\n/g, "\n");
            const normalizedNew = parsed.content.replace(/\r\n/g, "\n");
            if (normalizedCurrent !== normalizedNew) {
              await edit({
                file_path: parsed.path,
                old_string: currentContent,
                new_string: parsed.content,
              });
            }
            // else: content unchanged -- no-op, still respond success below
          }

          console.log(
            `[Listen] write_file success: ${parsed.path} (${parsed.content.length} bytes)`,
          );
          safeSocketSend(
            socket,
            {
              type: "write_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              success: true,
            },
            "listener_write_file_send_failed",
            "listener_write_file",
          );
        } catch (err) {
          console.error(
            `[Listen] write_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
          safeSocketSend(
            socket,
            {
              type: "write_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              success: false,
              error:
                err instanceof Error ? err.message : "Failed to write file",
            },
            "listener_write_file_send_failed",
            "listener_write_file",
          );
        }
      });
      return true;
    }

    // File watching (no runtime scope required)
    if (isWatchFileCommand(parsed)) {
      runDetachedListenerTask("watch_file", async () => {
        const existing = fileWatchers.get(parsed.path);
        if (existing) {
          existing.refCount++;
          return;
        }
        try {
          const { watch } = await import("node:fs");
          const { stat } = await import("node:fs/promises");
          // Check if unwatch arrived while we were awaiting imports
          if (cancelledWatches.delete(parsed.path)) return;
          const watcher = watch(
            parsed.path,
            { persistent: false },
            (eventType) => {
              // Handle both "change" (normal write) and "rename" (atomic
              // write-then-rename, common on Linux). We stat() the original
              // path -- if it still exists the content was updated; if not
              // the file was deleted and the catch handler cleans up.
              if (eventType !== "change" && eventType !== "rename") return;
              // Debounce: macOS/FSEvents can fire multiple rapid events
              // for a single save. Collapse into one file_changed push.
              const existing = watchDebounceTimers.get(parsed.path);
              if (existing) clearTimeout(existing);
              watchDebounceTimers.set(
                parsed.path,
                setTimeout(() => {
                  watchDebounceTimers.delete(parsed.path);
                  stat(parsed.path)
                    .then((s) => {
                      safeSocketSend(
                        socket,
                        {
                          type: "file_changed",
                          path: parsed.path,
                          lastModified: Math.round(s.mtimeMs),
                        },
                        "listener_file_changed_send_failed",
                        "listener_watch_file",
                      );
                    })
                    .catch(() => {
                      // File deleted -- stop watching
                      const entry = fileWatchers.get(parsed.path);
                      if (entry) {
                        entry.watcher.close();
                        fileWatchers.delete(parsed.path);
                      }
                    });
                }, 150),
              );
            },
          );
          watcher.on("error", () => {
            watcher.close();
            fileWatchers.delete(parsed.path);
          });
          fileWatchers.set(parsed.path, { watcher, refCount: 1 });
        } catch {
          // fs.watch not supported or path invalid -- silently ignore
        }
      });
      return true;
    }

    if (isUnwatchFileCommand(parsed)) {
      const entry = fileWatchers.get(parsed.path);
      if (entry) {
        entry.refCount--;
        if (entry.refCount <= 0) {
          entry.watcher.close();
          fileWatchers.delete(parsed.path);
        }
      } else {
        // watch_file async task may still be in flight -- mark for cancel
        cancelledWatches.add(parsed.path);
      }
      const timer = watchDebounceTimers.get(parsed.path);
      if (timer) {
        clearTimeout(timer);
        watchDebounceTimers.delete(parsed.path);
      }
      return true;
    }

    // File editing (no runtime scope required)
    if (isEditFileCommand(parsed)) {
      console.log(
        `[Listen] Received edit_file command: file_path=${parsed.file_path}, request_id=${parsed.request_id}`,
      );
      runDetachedListenerTask("edit_file", async () => {
        try {
          const { edit } = await import("@/tools/impl/edit");

          console.log(
            `[Listen] Executing edit: old_string="${parsed.old_string.slice(0, 50)}${parsed.old_string.length > 50 ? "..." : ""}"`,
          );
          const result = await edit({
            file_path: parsed.file_path,
            old_string: parsed.old_string,
            new_string: parsed.new_string,
            replace_all: parsed.replace_all,
            expected_replacements: parsed.expected_replacements,
          });
          console.log(
            `[Listen] edit_file success: ${result.replacements} replacement(s) at line ${result.startLine}`,
          );
          // Notify web clients of the new content so they can update live.
          if (result.replacements > 0) {
            try {
              const contentAfter = await readUtf8TextStrict(parsed.file_path);
              safeSocketSend(
                socket,
                {
                  type: "file_ops",
                  path: parsed.file_path,
                  cg_entries: [],
                  ops: [],
                  source: "agent",
                  document_content: contentAfter,
                },
                "listener_edit_file_ops_send_failed",
                "listener_edit_file",
              );
            } catch {
              // Non-fatal: content broadcast is best-effort.
            }
          }

          safeSocketSend(
            socket,
            {
              type: "edit_file_response",
              request_id: parsed.request_id,
              file_path: parsed.file_path,
              message: result.message,
              replacements: result.replacements,
              start_line: result.startLine,
              success: true,
            },
            "listener_edit_file_send_failed",
            "listener_edit_file",
          );
        } catch (err) {
          trackListenerError(
            "listener_edit_file_failed",
            err,
            "listener_file_edit",
          );
          console.error(
            `[Listen] edit_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
          safeSocketSend(
            socket,
            {
              type: "edit_file_response",
              request_id: parsed.request_id,
              file_path: parsed.file_path,
              message: null,
              replacements: 0,
              success: false,
              error: err instanceof Error ? err.message : "Failed to edit file",
            },
            "listener_edit_file_send_failed",
            "listener_edit_file",
          );
        }
      });
      return true;
    }

    // Egwalker CRDT ops (no runtime scope required)
    if (isFileOpsCommand(parsed)) {
      // Use document_content if provided (reliable, no race conditions).
      // Falls back to applying ops character-by-character.
      if (parsed.document_content !== undefined) {
        runDetachedListenerTask("file_ops", async () => {
          try {
            const content = parsed.document_content as string;
            await writeUtf8Text(parsed.path, content);
            console.log(
              `[Listen] file_ops: wrote ${content.length} bytes to ${parsed.path}`,
            );
          } catch (err) {
            console.error(
              `[Listen] file_ops error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
          }
        });
      }
      return true;
    }

    return false;
  };

  return { handle, dispose };
}
