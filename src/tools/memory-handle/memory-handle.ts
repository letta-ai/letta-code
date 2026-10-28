/**
 * The Git handle under the script `harness` binding (not a script global):
 * `read`, `list`, `log`, `diff`, a `commit()` builder, and `promote()` over
 * one agent memory repository.
 *
 * Targets:
 * - `{ agentId }`: that agent's MemFS — the local checkout on a local-only
 *   backend, otherwise the hosted repository;
 * - a path: a local Git checkout (relative paths resolve from the cwd).
 */

import { resolve } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import { openLocalMemoryRepo } from "./local-repo";
import { openRemoteMemoryRepo } from "./remote-repo";
import {
  type MemoryAuthor,
  type MemoryChange,
  type MemoryCommitResult,
  type MemoryRepoBackend,
  normalizeMemoryPath,
} from "./types";

const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 200;

/** What a write is about to touch, for the permission check. */
export interface MemoryWriteTarget {
  /** Local repository root, absent for hosted targets. */
  path?: string;
  agentId?: string;
  branch: string;
  /** Repository-relative paths the commit changes. */
  paths: string[];
}

export interface MemoryHandleContext {
  cwd: string;
  /** Agent invoking the script; authors commits and owns "own memory". */
  agentId: string | null;
  agentName: string | null;
  /** Read check: a local directory or an agent's memory. */
  checkRead(target: { path: string } | { agentId: string }): Promise<void>;
  /** Write check; throws when the write is not allowed. */
  checkWrite(target: MemoryWriteTarget): Promise<void>;
  /** Called after a successful hosted commit to the agent's own `main`. */
  onOwnMainCommit?(sha: string): Promise<void>;
}

export type MemoryOpenTarget = string | { agentId: string };

function parseTarget(
  target: unknown,
): { kind: "path"; path: string } | { kind: "agent"; agentId: string } {
  if (typeof target === "string" && target.trim()) {
    return { kind: "path", path: target };
  }
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const { agentId } = target as Record<string, unknown>;
    if (typeof agentId === "string" && agentId) {
      return { kind: "agent", agentId };
    }
  }
  throw new Error("Memory target must be a path or { agentId }.");
}

function optionObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} options must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function author(context: MemoryHandleContext): MemoryAuthor {
  return context.agentId
    ? {
        name: context.agentName?.trim() || "Letta Agent",
        email: `${context.agentId}@letta.com`,
      }
    : { name: "Letta Code", email: "noreply@letta.com" };
}

export async function openMemoryHandle(
  rawTarget: unknown,
  context: MemoryHandleContext,
) {
  const target = parseTarget(rawTarget);
  const localOnly =
    getBackend().capabilities.localMemfs &&
    !getBackend().capabilities.remoteMemfs;
  let backend: MemoryRepoBackend;
  let writeTarget: Omit<MemoryWriteTarget, "branch" | "paths">;
  if (target.kind === "path" || (target.kind === "agent" && localOnly)) {
    const directory =
      target.kind === "path"
        ? resolve(context.cwd, target.path)
        : getScopedMemoryFilesystemRoot(target.agentId);
    await context.checkRead({ path: directory });
    const local = await openLocalMemoryRepo(directory);
    if (local.root !== directory) await context.checkRead({ path: local.root });
    backend = local;
    writeTarget =
      target.kind === "agent"
        ? { path: local.root, agentId: target.agentId }
        : { path: local.root };
  } else {
    await context.checkRead({ agentId: target.agentId });
    backend = await openRemoteMemoryRepo(target.agentId);
    writeTarget = { agentId: target.agentId };
  }
  const ownHostedMemory =
    !localOnly && target.kind === "agent" && target.agentId === context.agentId;

  return Object.freeze({
    defaultBranch: backend.defaultRef,

    read(path: unknown, options?: unknown): Promise<string | null> {
      const ref = optionalString(optionObject(options, "read()"), "ref");
      return backend.read(normalizeMemoryPath(path), ref ?? backend.defaultRef);
    },

    list(options?: unknown): Promise<string[]> {
      const parsed = optionObject(options, "list()");
      const path = optionalString(parsed, "path");
      return backend.list({
        ...(path ? { path: normalizeMemoryPath(path) } : {}),
        ref: optionalString(parsed, "ref") ?? backend.defaultRef,
      });
    },

    log(options?: unknown) {
      const parsed = optionObject(options, "log()");
      const path = optionalString(parsed, "path");
      const limit = parsed.limit ?? DEFAULT_LOG_LIMIT;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_LOG_LIMIT
      ) {
        throw new Error(`log() limit must be an integer 1-${MAX_LOG_LIMIT}.`);
      }
      return backend.log({
        ...(path ? { path: normalizeMemoryPath(path) } : {}),
        ref: optionalString(parsed, "ref") ?? backend.defaultRef,
        limit,
      });
    },

    diff(options?: unknown) {
      const parsed = optionObject(options, "diff()");
      const ref = optionalString(parsed, "ref");
      if (!ref) throw new Error("diff() requires { ref }.");
      return backend.diff({
        ref,
        base: optionalString(parsed, "base") ?? backend.defaultRef,
      });
    },

    /**
     * Fast-forward `branch` (default main) to `ref` only while it still
     * points at `expect`; throws if it moved, so callers re-apply and retry.
     */
    async promote(
      options: unknown,
    ): Promise<MemoryCommitResult & { recompiled: boolean }> {
      const parsed = optionObject(options, "promote()");
      const ref = optionalString(parsed, "ref");
      const expect = optionalString(parsed, "expect");
      if (!ref || !expect) {
        throw new Error("promote() requires { ref, expect }.");
      }
      const branch = optionalString(parsed, "branch") ?? backend.defaultRef;
      const result = await backend.promote({
        branch,
        ref,
        expect,
        authorize: (paths) =>
          context.checkWrite({ ...writeTarget, branch, paths }),
      });
      let recompiled = false;
      if (
        result.changed &&
        ownHostedMemory &&
        branch === backend.defaultRef &&
        context.onOwnMainCommit
      ) {
        await context.onOwnMainCommit(result.sha);
        recompiled = true;
      }
      return { ...result, recompiled };
    },

    commit(options: unknown) {
      const parsed = optionObject(options, "commit()");
      const message = optionalString(parsed, "message");
      if (!message) throw new Error("commit() requires { message }.");
      const branch = optionalString(parsed, "branch") ?? backend.defaultRef;
      const base = optionalString(parsed, "base") ?? backend.defaultRef;
      const changes: MemoryChange[] = [];
      let sent = false;
      const builder = {
        put(path: unknown, content: unknown) {
          if (typeof content !== "string") {
            throw new Error("put() content must be a string.");
          }
          changes.push({
            kind: "put",
            path: normalizeMemoryPath(path),
            content,
          });
          return builder;
        },
        delete(path: unknown) {
          changes.push({ kind: "delete", path: normalizeMemoryPath(path) });
          return builder;
        },
        async send(): Promise<MemoryCommitResult & { recompiled: boolean }> {
          if (sent) throw new Error("send() was already called.");
          sent = true;
          if (changes.length === 0) {
            throw new Error("commit has no changes; call put() or delete().");
          }
          await context.checkWrite({
            ...writeTarget,
            branch,
            paths: [...new Set(changes.map((change) => change.path))],
          });
          const result = await backend.commit({
            message,
            branch,
            base,
            author: author(context),
            changes,
          });
          let recompiled = false;
          if (
            result.changed &&
            ownHostedMemory &&
            branch === backend.defaultRef &&
            context.onOwnMainCommit
          ) {
            await context.onOwnMainCommit(result.sha);
            recompiled = true;
          }
          return { ...result, recompiled };
        },
      };
      return builder;
    },
  });
}
