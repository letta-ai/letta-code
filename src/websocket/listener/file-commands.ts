import { lstat } from "node:fs/promises";
import path from "node:path";
import type WebSocket from "ws";
import {
  ensureFileIndex,
  getIndexRoot,
  refreshFileIndex,
  searchFileIndex,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import { runGrepInFiles } from "./grepInFiles";
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

/**
 * Detect whether a directory is a git worktree root.
 * Worktrees have a `.git` **file** (not directory) that points to the main
 * repo's `.git/worktrees/<name>`. This distinguishes them from normal repos
 * where `.git` is a directory.
 */
export async function isGitWorktreeRoot(dir: string): Promise<boolean> {
  try {
    const stats = await lstat(path.join(dir, ".git"));
    return stats.isFile();
  } catch {
    return false;
  }
}

/** File/directory names filtered from directory listings (OS/VCS noise). */
const DIR_LISTING_IGNORED_NAMES = new Set([".DS_Store", ".git", "Thumbs.db"]);

interface DirListing {
  folders: string[];
  files: string[];
}

/**
 * List a single directory by merging the file index (instant) with readdir
 * (to pick up `.lettaignore`'d entries). Shared by `list_in_directory` and
 * `get_tree` handlers.
 *
 * @param absDir Absolute path to the directory.
 * @param indexRoot Root of the file index (undefined if unavailable).
 * @param includeFiles Whether to include files (not just folders).
 */
async function listDirectoryHybrid(
  absDir: string,
  indexRoot: string | undefined,
  includeFiles: boolean,
): Promise<DirListing> {
  // 1. Query file index (instant, from memory)
  let indexedNames: Set<string> | undefined;
  const indexedFolders: string[] = [];
  const indexedFiles: string[] = [];

  if (indexRoot !== undefined) {
    const relPath = path.relative(indexRoot, absDir);
    if (!relPath.startsWith("..")) {
      const indexed = searchFileIndex({
        searchDir: relPath || ".",
        pattern: "",
        deep: false,
        maxResults: 10000,
      });
      indexedNames = new Set<string>();
      for (const entry of indexed) {
        const name = entry.path.split(path.sep).pop() ?? entry.path;
        indexedNames.add(name);
        if (entry.type === "dir") {
          indexedFolders.push(name);
        } else {
          indexedFiles.push(name);
        }
      }
    }
  }

  // 2. readdir to fill gaps (entries not in the index)
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(absDir, { withFileTypes: true });

  const extraFolders: string[] = [];
  const extraFiles: string[] = [];
  for (const e of entries) {
    if (DIR_LISTING_IGNORED_NAMES.has(e.name)) continue;
    if (indexedNames?.has(e.name)) continue;
    if (e.isDirectory()) {
      extraFolders.push(e.name);
    } else if (includeFiles) {
      extraFiles.push(e.name);
    }
  }

  // 3. Merge and sort
  return {
    folders: [...indexedFolders, ...extraFolders].sort((a, b) =>
      a.localeCompare(b),
    ),
    files: includeFiles
      ? [...indexedFiles, ...extraFiles].sort((a, b) => a.localeCompare(b))
      : [],
  };
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
          // When the requested cwd lives outside the current index root
          // (e.g. a persisted CWD restored on startup that was never fed
          // through handleCwdChange), re-root the file index first so
          // the search covers the correct workspace.
          if (parsed.cwd) {
            const currentRoot = getIndexRoot();
            const needsReroot =
              (!parsed.cwd.startsWith(currentRoot + path.sep) &&
                parsed.cwd !== currentRoot) ||
              (parsed.cwd !== currentRoot &&
                (await isGitWorktreeRoot(parsed.cwd)));
            if (needsReroot) {
              setIndexRoot(parsed.cwd);
            }
          }

          await ensureFileIndex();

          // Scope search to the conversation's cwd when provided.
          // The file index stores paths relative to the index root.
          let searchDir = ".";
          if (parsed.cwd) {
            const rel = path.relative(getIndexRoot(), parsed.cwd);
            // Only scope if cwd is within the index root (not "../" etc.)
            if (rel && !rel.startsWith("..") && rel !== "") {
              searchDir = rel;
            }
          }

          const files = searchFileIndex({
            searchDir,
            pattern: parsed.query,
            deep: true,
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
          // Re-root the index if the requested cwd lives outside it, so
          // "search root" matches what the user expects in the UI.
          if (parsed.cwd) {
            const currentRoot = getIndexRoot();
            if (
              !parsed.cwd.startsWith(currentRoot + path.sep) &&
              parsed.cwd !== currentRoot
            ) {
              setIndexRoot(parsed.cwd);
            }
          }

          const searchRoot = parsed.cwd ?? getIndexRoot();
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
          let indexRoot: string | undefined;
          try {
            await ensureFileIndex();
            indexRoot = getIndexRoot();
          } catch {
            // Index not available -- readdir only
          }

          console.log(`[Listen] Reading directory: ${parsed.path}`);
          const { folders: allFolders, files: allFiles } =
            await listDirectoryHybrid(
              parsed.path,
              indexRoot,
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
          // Walk the directory tree up to the requested depth, combining file
          // index results with readdir to include non-indexed entries.
          interface TreeEntry {
            path: string;
            type: "file" | "dir";
          }
          const results: TreeEntry[] = [];
          let hasMoreDepth = false;

          // Warm the file index once before walking the tree.
          let indexRoot: string | undefined;
          try {
            await ensureFileIndex();
            indexRoot = getIndexRoot();
          } catch {
            // Index not available -- readdir only for all directories
          }

          // BFS queue: [absolutePath, relativePath, currentDepth]
          // Uses an index pointer for O(1) dequeue instead of shift().
          const queue: [string, string, number][] = [[parsed.path, "", 0]];
          let qi = 0;

          while (qi < queue.length) {
            const item = queue[qi++];
            if (!item) break;
            const [absDir, relDir, depth] = item;

            if (depth >= parsed.depth) {
              if (depth === parsed.depth && relDir !== "") {
                hasMoreDepth = true;
              }
              continue;
            }

            let listing: DirListing;
            try {
              listing = await listDirectoryHybrid(absDir, indexRoot, true);
            } catch {
              // Can't read directory -- skip
              continue;
            }

            // Relative paths always use '/' (converted to OS separator on the frontend)
            for (const name of listing.folders) {
              const entryRel = relDir === "" ? name : `${relDir}/${name}`;
              results.push({ path: entryRel, type: "dir" });
              queue.push([path.join(absDir, name), entryRel, depth + 1]);
            }
            for (const name of listing.files) {
              const entryRel = relDir === "" ? name : `${relDir}/${name}`;
              results.push({ path: entryRel, type: "file" });
            }
          }

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
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(parsed.path, "utf-8");
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
          const { edit } = await import("../../tools/impl/Edit");
          const { write } = await import("../../tools/impl/Write");
          const { readFile } = await import("node:fs/promises");

          // Read current content so we can use edit for an atomic
          // read-modify-write that goes through the same code path as
          // the agent's Edit tool (CRLF normalisation, rich errors, etc.).
          let currentContent: string | null = null;
          try {
            currentContent = await readFile(parsed.path, "utf-8");
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
          // Update the file index so the sidebar Merkle tree stays current
          void refreshFileIndex();
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
          const { readFile } = await import("node:fs/promises");
          const { edit } = await import("../../tools/impl/Edit");

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
          // Update the file index so the sidebar Merkle tree stays current
          if (result.replacements > 0) {
            void refreshFileIndex();
          }

          // Notify web clients of the new content so they can update live.
          if (result.replacements > 0) {
            try {
              const contentAfter = await readFile(parsed.file_path, "utf-8");
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
            const { writeFile } = await import("node:fs/promises");
            const content = parsed.document_content as string;
            await writeFile(parsed.path, content, "utf-8");
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
