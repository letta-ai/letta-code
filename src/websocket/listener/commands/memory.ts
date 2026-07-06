import type WebSocket from "ws";
import type { EnsureLocalMemfsCheckoutOptions } from "@/agent/memory-filesystem";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type { ListMemoryCommand } from "@/types/protocol_v2";
import {
  isDeleteMemoryFileCommand,
  isEnableMemfsCommand,
  isListMemoryCommand,
  isMemoryCommitDiffCommand,
  isMemoryFileAtRefCommand,
  isMemoryHistoryCommand,
  isReadMemoryFileCommand,
  isWriteMemoryFileCommand,
} from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

// Image assets the memory viewer can render inline. Must stay in sync with
// the server-side memory files API's supported image set.
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function getLowercaseExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= lastSlash) return "";
  return path.slice(lastDot).toLowerCase();
}

function getMemoryImageMimeType(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[getLowercaseExtension(path)] ?? null;
}

function isMarkdownMemoryPath(path: string): boolean {
  return getLowercaseExtension(path) === ".md";
}

export type ListMemoryCommandTestOverrides = {
  ensureLocalMemfsCheckout?: (
    agentId: string,
    options?: EnsureLocalMemfsCheckoutOptions,
  ) => Promise<void>;
  getMemoryFilesystemRoot?: (agentId: string) => string;
  isMemfsEnabledOnServer?: (agentId: string) => Promise<boolean>;
};

type ListMemoryCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

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

export async function handleListMemoryCommand(
  parsed: ListMemoryCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  overrides: ListMemoryCommandTestOverrides = {},
): Promise<boolean> {
  try {
    const {
      ensureLocalMemfsCheckout: actualEnsureLocalMemfsCheckout,
      getScopedMemoryFilesystemRoot: actualGetMemoryFilesystemRoot,
      isMemfsEnabledOnServer: actualIsMemfsEnabledOnServer,
    } = await import("@/agent/memory-filesystem");
    const ensureLocalMemfsCheckout =
      overrides.ensureLocalMemfsCheckout ?? actualEnsureLocalMemfsCheckout;
    const getMemoryFilesystemRoot =
      overrides.getMemoryFilesystemRoot ?? actualGetMemoryFilesystemRoot;
    const isMemfsEnabledOnServer =
      overrides.isMemfsEnabledOnServer ?? actualIsMemfsEnabledOnServer;
    const { scanMemoryFilesystem, getFileNodes, readFileContent } =
      await import("@/agent/memory-scanner");
    const { parseFrontmatter } = await import("@/utils/frontmatter");

    const { existsSync, statSync } = await import("node:fs");
    const { join, posix } = await import("node:path");

    const memoryRoot = getMemoryFilesystemRoot(parsed.agent_id);
    let memfsInitialized = existsSync(join(memoryRoot, ".git"));
    const memfsEnabled = memfsInitialized
      ? true
      : await isMemfsEnabledOnServer(parsed.agent_id);

    if (!memfsEnabled) {
      safeSocketSend(
        socket,
        {
          type: "list_memory_response",
          request_id: parsed.request_id,
          entries: [],
          done: true,
          total: 0,
          success: true,
          memfs_enabled: false,
          memfs_initialized: false,
        },
        "listener_list_memory_send_failed",
        "listener_list_memory",
      );
      return true;
    }

    await ensureLocalMemfsCheckout(parsed.agent_id, {
      pullOnExistingRepo: true,
    });
    memfsInitialized = existsSync(join(memoryRoot, ".git"));

    if (!memfsInitialized) {
      throw new Error(
        "MemFS is enabled, but the local memory checkout could not be initialized.",
      );
    }

    const treeNodes = scanMemoryFilesystem(memoryRoot);
    const fileNodes = getFileNodes(treeNodes).filter(
      (n) =>
        isMarkdownMemoryPath(n.relativePath) ||
        getMemoryImageMimeType(n.relativePath) !== null,
    );
    const includeReferences = parsed.include_references === true;

    // Wiki-link references only ever resolve to markdown files.
    const allPaths = new Set(
      fileNodes
        .map((node) => node.relativePath)
        .filter((path) => isMarkdownMemoryPath(path)),
    );

    const normalizeMemoryReference = (
      rawReference: string,
      sourcePath: string,
    ): string | null => {
      let target = rawReference.trim();
      if (!target) {
        return null;
      }

      if (
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:")
      ) {
        return null;
      }

      target = target.replace(/^<|>$/g, "");
      target = target.split("#")[0] ?? "";
      target = target.split("?")[0] ?? "";
      target = target.trim().replace(/\\/g, "/");

      if (!target || target.startsWith("#")) {
        return null;
      }

      if (target.includes("|")) {
        target = target.split("|")[0] ?? "";
      }

      if (!target) {
        return null;
      }

      const sourceDir = posix.dirname(sourcePath.replace(/\\/g, "/"));
      const candidate =
        target.startsWith("./") || target.startsWith("../")
          ? posix.normalize(posix.join(sourceDir, target))
          : posix.normalize(target.startsWith("/") ? target.slice(1) : target);

      if (
        !candidate ||
        candidate.startsWith("../") ||
        candidate === "." ||
        candidate === ".."
      ) {
        return null;
      }

      const withExtension = candidate.endsWith(".md")
        ? candidate
        : `${candidate}.md`;

      const candidates = new Set<string>([withExtension]);

      const isExplicitRelative =
        target.startsWith("./") || target.startsWith("../");
      if (
        !isExplicitRelative &&
        !target.startsWith("/") &&
        sourceDir &&
        sourceDir !== "."
      ) {
        candidates.add(posix.normalize(posix.join(sourceDir, withExtension)));
      }

      if (!withExtension.startsWith("system/")) {
        candidates.add(posix.normalize(`system/${withExtension}`));
      }

      for (const resolved of candidates) {
        if (allPaths.has(resolved)) {
          return resolved;
        }
      }

      return null;
    };

    const extractMemoryReferences = (
      body: string,
      sourcePath: string,
    ): string[] => {
      if (!body.includes("[[")) {
        return [];
      }

      const refs = new Set<string>();

      for (const wikiMatch of body.matchAll(WIKI_LINK_REGEX)) {
        const rawTarget = wikiMatch[1];
        if (!rawTarget) continue;
        const normalized = normalizeMemoryReference(rawTarget, sourcePath);
        if (normalized && normalized !== sourcePath) {
          refs.add(normalized);
        }
      }

      return [...refs];
    };

    const CHUNK_SIZE = 5;
    const total = fileNodes.length;

    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = fileNodes.slice(i, i + CHUNK_SIZE);
      const entries = chunk.map((node) => {
        const isSystem =
          node.relativePath.startsWith("system/") ||
          node.relativePath.startsWith("system\\");

        const imageMimeType = getMemoryImageMimeType(node.relativePath);
        if (imageMimeType) {
          let size = 0;
          try {
            size = statSync(node.fullPath).size;
          } catch {}
          return {
            relative_path: node.relativePath,
            is_system: isSystem,
            description: null,
            content: "",
            size,
            ...(includeReferences ? { references: [] } : {}),
            kind: "image" as const,
            mime_type: imageMimeType,
          };
        }

        const raw = readFileContent(node.fullPath);
        const { frontmatter, body } = parseFrontmatter(raw);
        const desc = frontmatter.description;
        return {
          relative_path: node.relativePath,
          is_system: isSystem,
          description: typeof desc === "string" ? desc : null,
          content: body,
          size: body.length,
          ...(includeReferences
            ? {
                references: extractMemoryReferences(body, node.relativePath),
              }
            : {}),
          kind: "markdown" as const,
          mime_type: "text/markdown",
        };
      });

      const done = i + CHUNK_SIZE >= total;
      const sent = safeSocketSend(
        socket,
        {
          type: "list_memory_response",
          request_id: parsed.request_id,
          entries,
          done,
          total,
          success: true,
          memfs_enabled: true,
          memfs_initialized: true,
        },
        "listener_list_memory_send_failed",
        "listener_list_memory",
      );
      if (!sent) {
        return true;
      }
    }

    if (total === 0) {
      safeSocketSend(
        socket,
        {
          type: "list_memory_response",
          request_id: parsed.request_id,
          entries: [],
          done: true,
          total: 0,
          success: true,
          memfs_enabled: true,
          memfs_initialized: true,
        },
        "listener_list_memory_send_failed",
        "listener_list_memory",
      );
    }
  } catch (err) {
    trackListenerError(
      "listener_list_memory_failed",
      err,
      "listener_memory_browser",
    );
    safeSocketSend(
      socket,
      {
        type: "list_memory_response",
        request_id: parsed.request_id,
        entries: [],
        done: true,
        total: 0,
        success: false,
        error: err instanceof Error ? err.message : "Failed to list memory",
      },
      "listener_list_memory_send_failed",
      "listener_list_memory",
    );
  }

  return true;
}

export function handleMemoryProtocolCommand(
  parsed: unknown,
  context: ListMemoryCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (isListMemoryCommand(parsed)) {
    runDetachedListenerTask("list_memory", async () => {
      await handleListMemoryCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  // ── Enable memfs command ────────────────────────────────────────────
  if (isEnableMemfsCommand(parsed)) {
    runDetachedListenerTask("enable_memfs", async () => {
      try {
        const { applyMemfsFlags } = await import("@/agent/memory-filesystem");
        const result = await applyMemfsFlags(parsed.agent_id, true);
        safeSocketSend(
          socket,
          {
            type: "enable_memfs_response",
            request_id: parsed.request_id,
            success: true,
            memory_directory: result.memoryDir,
          },
          "listener_enable_memfs_send_failed",
          "listener_enable_memfs",
        );
        // Push memory_updated so the UI auto-refreshes its file list
        safeSocketSend(
          socket,
          {
            type: "memory_updated",
            affected_paths: ["*"],
            timestamp: Date.now(),
          },
          "listener_enable_memfs_send_failed",
          "listener_enable_memfs",
        );
      } catch (err) {
        trackListenerError(
          "listener_enable_memfs_failed",
          err,
          "listener_memfs_enable",
        );
        safeSocketSend(
          socket,
          {
            type: "enable_memfs_response",
            request_id: parsed.request_id,
            success: false,
            error:
              err instanceof Error ? err.message : "Failed to enable memfs",
          },
          "listener_enable_memfs_send_failed",
          "listener_enable_memfs",
        );
      }
    });
    return true;
  }

  // ── Memory history (git log for a specific file) ─────────────────
  if (isMemoryHistoryCommand(parsed)) {
    runDetachedListenerTask("memory_history", async () => {
      const { getScopedMemoryFilesystemRoot } = await import(
        "@/agent/memory-filesystem"
      );
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);

      const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);
      const limit = parsed.limit ?? 50;

      const gitArgs = ["log", `--max-count=${limit}`, "--format=%H|%s|%aI|%an"];
      // When file_path is provided, scope to that file
      if (parsed.file_path) {
        gitArgs.push("--", parsed.file_path);
      }

      const { stdout } = await execFileAsync("git", gitArgs, {
        cwd: memoryRoot,
        timeout: 10000,
      });

      const commits = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [sha, message, timestamp, authorName] = line.split("|");
          return {
            sha: sha ?? "",
            message: message ?? "",
            timestamp: timestamp ?? "",
            author_name: authorName ?? null,
          };
        });

      safeSocketSend(
        socket,
        {
          type: "memory_history_response",
          request_id: parsed.request_id,
          file_path: parsed.file_path ?? "",
          commits,
          success: true,
        },
        "listener_memory_history_send_failed",
        "listener_memory_history",
      );
    });
    return true;
  }

  // ── Memory file at ref (git show for content at a commit) ────────
  if (isMemoryFileAtRefCommand(parsed)) {
    runDetachedListenerTask("memory_file_at_ref", async () => {
      const { getScopedMemoryFilesystemRoot } = await import(
        "@/agent/memory-filesystem"
      );
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);

      const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);

      try {
        const { stdout } = await execFileAsync(
          "git",
          ["show", `${parsed.ref}:${parsed.file_path}`],
          { cwd: memoryRoot, timeout: 10000 },
        );

        safeSocketSend(
          socket,
          {
            type: "memory_file_at_ref_response",
            request_id: parsed.request_id,
            file_path: parsed.file_path,
            ref: parsed.ref,
            content: stdout,
            success: true,
          },
          "listener_memory_file_at_ref_send_failed",
          "listener_memory_file_at_ref",
        );
      } catch (err) {
        safeSocketSend(
          socket,
          {
            type: "memory_file_at_ref_response",
            request_id: parsed.request_id,
            file_path: parsed.file_path,
            ref: parsed.ref,
            content: null,
            success: false,
            error:
              err instanceof Error ? err.message : "Failed to read file at ref",
          },
          "listener_memory_file_at_ref_send_failed",
          "listener_memory_file_at_ref",
        );
      }
    });
    return true;
  }

  // ── Memory commit diff (git show for full commit patch) ────────────
  if (isMemoryCommitDiffCommand(parsed)) {
    runDetachedListenerTask("memory_commit_diff", async () => {
      const { getScopedMemoryFilesystemRoot } = await import(
        "@/agent/memory-filesystem"
      );
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);

      const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);

      try {
        const { stdout } = await execFileAsync(
          "git",
          ["show", parsed.sha, "--format=", "--no-color"],
          { cwd: memoryRoot, timeout: 10000 },
        );

        safeSocketSend(
          socket,
          {
            type: "memory_commit_diff_response",
            request_id: parsed.request_id,
            sha: parsed.sha,
            diff: stdout,
            success: true,
          },
          "listener_memory_commit_diff_send_failed",
          "listener_memory_commit_diff",
        );
      } catch (err) {
        safeSocketSend(
          socket,
          {
            type: "memory_commit_diff_response",
            request_id: parsed.request_id,
            sha: parsed.sha,
            diff: null,
            success: false,
            error:
              err instanceof Error ? err.message : "Failed to get commit diff",
          },
          "listener_memory_commit_diff_send_failed",
          "listener_memory_commit_diff",
        );
      }
    });
    return true;
  }

  // ── Read a file from the MemFS working tree ───────────────────────
  if (isReadMemoryFileCommand(parsed)) {
    runDetachedListenerTask("read_memory_file", async () => {
      const encoding = parsed.encoding ?? "utf8";
      const sendFailure = (error: string): void => {
        safeSocketSend(
          socket,
          {
            type: "read_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: parsed.path,
            content: null,
            encoding,
            success: false,
            error,
          },
          "listener_read_memory_file_send_failed",
          "listener_read_memory_file",
        );
      };

      try {
        const {
          getScopedMemoryFilesystemRoot,
          ensureLocalMemfsCheckout,
          isMemfsEnabledOnServer,
        } = await import("@/agent/memory-filesystem");
        const { readFile } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const { isAbsolute, join, normalize, relative, sep } = await import(
          "node:path"
        );

        // Reject absolute paths or escapes outside memory root.
        if (isAbsolute(parsed.path) || parsed.path.length === 0) {
          sendFailure("path must be a non-empty relative path");
          return;
        }
        const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);
        const absolutePath = normalize(join(memoryRoot, parsed.path));
        const rel = relative(memoryRoot, absolutePath);
        if (
          rel.startsWith("..") ||
          rel === "" ||
          isAbsolute(rel) ||
          rel.split(sep).includes("..")
        ) {
          sendFailure("path must resolve inside the memory root");
          return;
        }

        // Clone memfs on first read if it isn't local yet.
        if (!existsSync(join(memoryRoot, ".git"))) {
          const enabled = await isMemfsEnabledOnServer(parsed.agent_id);
          if (!enabled) {
            sendFailure("memfs is not enabled for this agent");
            return;
          }
          await ensureLocalMemfsCheckout(parsed.agent_id);
          if (!existsSync(join(memoryRoot, ".git"))) {
            sendFailure("failed to initialize local memory checkout");
            return;
          }
        }

        const buffer = await readFile(absolutePath);
        const content =
          encoding === "base64"
            ? buffer.toString("base64")
            : buffer.toString("utf-8");
        const pathspec = rel.split(sep).join("/");

        safeSocketSend(
          socket,
          {
            type: "read_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: pathspec,
            content,
            encoding,
            success: true,
          },
          "listener_read_memory_file_send_failed",
          "listener_read_memory_file",
        );
      } catch (err) {
        trackListenerError(
          "listener_read_memory_file_failed",
          err,
          "listener_memory_read",
        );
        console.error(
          `[Listen] read_memory_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        sendFailure(
          err instanceof Error ? err.message : "Failed to read memory file",
        );
      }
    });
    return true;
  }

  // ── Write a file into MemFS (durable agent memory write + commit) ───────
  if (isWriteMemoryFileCommand(parsed)) {
    runDetachedListenerTask("write_memory_file", async () => {
      const encoding = parsed.encoding ?? "utf8";
      const sendFailure = (error: string): void => {
        safeSocketSend(
          socket,
          {
            type: "write_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: parsed.path,
            success: false,
            error,
          },
          "listener_write_memory_file_send_failed",
          "listener_write_memory_file",
        );
      };

      try {
        const {
          getScopedMemoryFilesystemRoot,
          ensureLocalMemfsCheckout,
          isMemfsEnabledOnServer,
        } = await import("@/agent/memory-filesystem");
        const { commitMemoryWrite } = await import("@/agent/memory-git");
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const { dirname, isAbsolute, join, normalize, relative, sep } =
          await import("node:path");

        // ── Validate relative path ─────────────────────────────────────
        if (isAbsolute(parsed.path) || parsed.path.length === 0) {
          sendFailure(
            "write_memory_file: path must be a non-empty relative path",
          );
          return;
        }
        const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);
        const absolutePath = normalize(join(memoryRoot, parsed.path));
        const rel = relative(memoryRoot, absolutePath);
        if (
          rel.startsWith("..") ||
          rel === "" ||
          isAbsolute(rel) ||
          rel.split(sep).includes("..")
        ) {
          sendFailure(
            "write_memory_file: path must resolve inside the memory root",
          );
          return;
        }

        // ── Ensure MemFS is enabled and checked out ───────────────────
        if (!existsSync(join(memoryRoot, ".git"))) {
          const enabled = await isMemfsEnabledOnServer(parsed.agent_id);
          if (!enabled) {
            sendFailure(
              "write_memory_file: memfs is not enabled for this agent",
            );
            return;
          }
          await ensureLocalMemfsCheckout(parsed.agent_id);
          if (!existsSync(join(memoryRoot, ".git"))) {
            sendFailure(
              "write_memory_file: failed to initialize local memory checkout",
            );
            return;
          }
        }

        // ── Decode + write bytes (binary-safe for base64) ──────────────
        const buffer =
          encoding === "base64"
            ? Buffer.from(parsed.content, "base64")
            : Buffer.from(parsed.content, "utf-8");
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, buffer);

        const { getBackend } = await import("@/backend");
        const backend = getBackend();
        const memorySyncMode =
          backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs
            ? "local"
            : undefined;

        // ── Resolve agent identity for the commit author ───────────────
        let agentName = parsed.agent_id;
        try {
          const agent = await backend.retrieveAgent(parsed.agent_id);
          if (agent.name && agent.name.trim().length > 0) {
            agentName = agent.name.trim();
          }
        } catch {
          // Best-effort — fall back to agent id as the author name.
        }

        // ── Commit locally; post-turn harness sync handles remote push ─
        // Use posix separators in the pathspec — git expects forward slashes
        // even on Windows.
        const pathspec = rel.split(sep).join("/");
        const reason =
          parsed.commit_message?.trim() || `Update memory file ${pathspec}`;
        const commitResult = await commitMemoryWrite({
          memoryDir: memoryRoot,
          pathspecs: [pathspec],
          reason,
          author: {
            agentId: parsed.agent_id,
            authorName: agentName,
            authorEmail: `${parsed.agent_id}@letta.com`,
          },
          ...(memorySyncMode ? { syncMode: memorySyncMode } : {}),
        });

        // ── Push before notifying (non-turn writes don't get post-turn ──
        // sync). Server-of-record reads (e.g. the agent profile picture
        // endpoint) are served from the remote memfs, so emitting
        // memory_updated / the response before the push lands lets the UI
        // refetch stale bytes and drop its optimistic state (LET-9481).
        // On push failure, warn and continue — the local commit succeeded
        // and a later sync will retry.
        if (commitResult.committed && !memorySyncMode) {
          const { syncPendingMemoryCommitsAfterTurn } = await import(
            "@/agent/memory-git"
          );
          try {
            const syncResult = await syncPendingMemoryCommitsAfterTurn(
              parsed.agent_id,
              { memoryDir: memoryRoot },
            );
            if (
              syncResult.status === "push_failed" ||
              syncResult.status === "conflict"
            ) {
              console.warn(
                `[write_memory_file] push failed for ${parsed.agent_id}: ${syncResult.summary}`,
              );
            }
          } catch (err) {
            console.warn(
              `[write_memory_file] push failed for ${parsed.agent_id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        // ── Notify UI so the memory view auto-refreshes ────────────────
        if (commitResult.committed) {
          safeSocketSend(
            socket,
            {
              type: "memory_updated",
              affected_paths: [pathspec],
              timestamp: Date.now(),
            },
            "listener_write_memory_file_send_failed",
            "listener_write_memory_file",
          );
        }

        safeSocketSend(
          socket,
          {
            type: "write_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: pathspec,
            success: true,
            committed: commitResult.committed,
            ...(commitResult.sha ? { commit_sha: commitResult.sha } : {}),
          },
          "listener_write_memory_file_send_failed",
          "listener_write_memory_file",
        );
      } catch (err) {
        trackListenerError(
          "listener_write_memory_file_failed",
          err,
          "listener_memory_write",
        );
        console.error(
          `[Listen] write_memory_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        sendFailure(
          err instanceof Error ? err.message : "Failed to write memory file",
        );
      }
    });
    return true;
  }

  // ── Delete a file from MemFS (durable agent memory delete + commit) ──────
  if (isDeleteMemoryFileCommand(parsed)) {
    runDetachedListenerTask("delete_memory_file", async () => {
      const sendFailure = (error: string): void => {
        safeSocketSend(
          socket,
          {
            type: "delete_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: parsed.path,
            success: false,
            error,
          },
          "listener_delete_memory_file_send_failed",
          "listener_delete_memory_file",
        );
      };

      try {
        const {
          getScopedMemoryFilesystemRoot,
          ensureLocalMemfsCheckout,
          isMemfsEnabledOnServer,
        } = await import("@/agent/memory-filesystem");
        const { commitMemoryWrite } = await import("@/agent/memory-git");
        const { unlink } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const { isAbsolute, join, normalize, relative, sep } = await import(
          "node:path"
        );

        // ── Validate relative path ─────────────────────────────────────
        if (isAbsolute(parsed.path) || parsed.path.length === 0) {
          sendFailure(
            "delete_memory_file: path must be a non-empty relative path",
          );
          return;
        }
        const memoryRoot = getScopedMemoryFilesystemRoot(parsed.agent_id);
        const absolutePath = normalize(join(memoryRoot, parsed.path));
        const rel = relative(memoryRoot, absolutePath);
        if (
          rel.startsWith("..") ||
          rel === "" ||
          isAbsolute(rel) ||
          rel.split(sep).includes("..")
        ) {
          sendFailure(
            "delete_memory_file: path must resolve inside the memory root",
          );
          return;
        }

        // ── Ensure MemFS is enabled and checked out ───────────────────
        if (!existsSync(join(memoryRoot, ".git"))) {
          const enabled = await isMemfsEnabledOnServer(parsed.agent_id);
          if (!enabled) {
            sendFailure(
              "delete_memory_file: memfs is not enabled for this agent",
            );
            return;
          }
          await ensureLocalMemfsCheckout(parsed.agent_id);
          if (!existsSync(join(memoryRoot, ".git"))) {
            sendFailure(
              "delete_memory_file: failed to initialize local memory checkout",
            );
            return;
          }
        }

        const pathspec = rel.split(sep).join("/");

        // ── Idempotent delete: missing file is a no-op success ─────────
        const removeIfPresent = async (): Promise<boolean> => {
          if (!existsSync(absolutePath)) return false;
          await unlink(absolutePath);
          return true;
        };
        const removed = await removeIfPresent();
        if (!removed) {
          safeSocketSend(
            socket,
            {
              type: "delete_memory_file_response",
              request_id: parsed.request_id,
              agent_id: parsed.agent_id,
              path: pathspec,
              success: true,
              committed: false,
            },
            "listener_delete_memory_file_send_failed",
            "listener_delete_memory_file",
          );
          return;
        }

        const { getBackend } = await import("@/backend");
        const backend = getBackend();
        const memorySyncMode =
          backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs
            ? "local"
            : undefined;

        // ── Resolve agent identity for the commit author ───────────────
        let agentName = parsed.agent_id;
        try {
          const agent = await backend.retrieveAgent(parsed.agent_id);
          if (agent.name && agent.name.trim().length > 0) {
            agentName = agent.name.trim();
          }
        } catch {
          // Best-effort — fall back to agent id as the author name.
        }

        // ── Commit locally; post-turn harness sync handles remote push ─
        const reason =
          parsed.commit_message?.trim() || `Delete memory file ${pathspec}`;
        const commitResult = await commitMemoryWrite({
          memoryDir: memoryRoot,
          pathspecs: [pathspec],
          reason,
          author: {
            agentId: parsed.agent_id,
            authorName: agentName,
            authorEmail: `${parsed.agent_id}@letta.com`,
          },
          ...(memorySyncMode ? { syncMode: memorySyncMode } : {}),
        });

        // ── Push before notifying (non-turn deletes don't get post-turn ─
        // sync). Same ordering requirement as write_memory_file: remote
        // reads must not race the push (LET-9481). On push failure, warn
        // and continue — the local commit succeeded and a later sync will
        // retry.
        if (commitResult.committed && !memorySyncMode) {
          const { syncPendingMemoryCommitsAfterTurn } = await import(
            "@/agent/memory-git"
          );
          try {
            const syncResult = await syncPendingMemoryCommitsAfterTurn(
              parsed.agent_id,
              { memoryDir: memoryRoot },
            );
            if (
              syncResult.status === "push_failed" ||
              syncResult.status === "conflict"
            ) {
              console.warn(
                `[delete_memory_file] push failed for ${parsed.agent_id}: ${syncResult.summary}`,
              );
            }
          } catch (err) {
            console.warn(
              `[delete_memory_file] push failed for ${parsed.agent_id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        if (commitResult.committed) {
          safeSocketSend(
            socket,
            {
              type: "memory_updated",
              affected_paths: [pathspec],
              timestamp: Date.now(),
            },
            "listener_delete_memory_file_send_failed",
            "listener_delete_memory_file",
          );
        }

        safeSocketSend(
          socket,
          {
            type: "delete_memory_file_response",
            request_id: parsed.request_id,
            agent_id: parsed.agent_id,
            path: pathspec,
            success: true,
            committed: commitResult.committed,
            ...(commitResult.sha ? { commit_sha: commitResult.sha } : {}),
          },
          "listener_delete_memory_file_send_failed",
          "listener_delete_memory_file",
        );
      } catch (err) {
        trackListenerError(
          "listener_delete_memory_file_failed",
          err,
          "listener_memory_delete",
        );
        console.error(
          `[Listen] delete_memory_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        sendFailure(
          err instanceof Error ? err.message : "Failed to delete memory file",
        );
      }
    });
    return true;
  }

  return false;
}
