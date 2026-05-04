import type WebSocket from "ws";
import { trackBoundaryError } from "../../../telemetry/errorReporting";
import type { ListMemoryCommand } from "../../../types/protocol_v2";
import { isListMemoryCommand } from "../protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export type ListMemoryCommandTestOverrides = {
  ensureLocalMemfsCheckout?: (agentId: string) => Promise<void>;
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
      getMemoryFilesystemRoot: actualGetMemoryFilesystemRoot,
      isMemfsEnabledOnServer: actualIsMemfsEnabledOnServer,
    } = await import("../../../agent/memoryFilesystem");
    const ensureLocalMemfsCheckout =
      overrides.ensureLocalMemfsCheckout ?? actualEnsureLocalMemfsCheckout;
    const getMemoryFilesystemRoot =
      overrides.getMemoryFilesystemRoot ?? actualGetMemoryFilesystemRoot;
    const isMemfsEnabledOnServer =
      overrides.isMemfsEnabledOnServer ?? actualIsMemfsEnabledOnServer;
    const { scanMemoryFilesystem, getFileNodes, readFileContent } =
      await import("../../../agent/memoryScanner");
    const { parseFrontmatter } = await import("../../../utils/frontmatter");

    const { existsSync } = await import("node:fs");
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

    if (!memfsInitialized) {
      await ensureLocalMemfsCheckout(parsed.agent_id);
      memfsInitialized = existsSync(join(memoryRoot, ".git"));
    }

    if (!memfsInitialized) {
      throw new Error(
        "MemFS is enabled, but the local memory checkout could not be initialized.",
      );
    }

    const treeNodes = scanMemoryFilesystem(memoryRoot);
    const fileNodes = getFileNodes(treeNodes).filter((n) =>
      n.name.endsWith(".md"),
    );
    const includeReferences = parsed.include_references === true;

    const allPaths = new Set(fileNodes.map((node) => node.relativePath));

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
        const raw = readFileContent(node.fullPath);
        const { frontmatter, body } = parseFrontmatter(raw);
        const desc = frontmatter.description;
        return {
          relative_path: node.relativePath,
          is_system:
            node.relativePath.startsWith("system/") ||
            node.relativePath.startsWith("system\\"),
          description: typeof desc === "string" ? desc : null,
          content: body,
          size: body.length,
          ...(includeReferences
            ? {
                references: extractMemoryReferences(body, node.relativePath),
              }
            : {}),
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

export function handleListMemoryProtocolCommand(
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

  return false;
}
