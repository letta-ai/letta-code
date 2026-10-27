/**
 * A memory handle over a local Git checkout (a path, or an agent's MemFS on
 * the local backend). Commits are made in a disposable linked worktree so the
 * repository's own hooks validate them and the caller's uncommitted edits are
 * never staged; the result then fast-forwards (or merges into) the checked-out
 * branch, or moves an unchecked-out branch ref directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit } from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryDiffEntry,
  MemoryLogEntry,
  MemoryRepoBackend,
} from "./types";

const ZERO_SHA = "0".repeat(40);
const LOG_FORMAT = "%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e";

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).stdout;
  } catch {
    return null;
  }
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  const out = await tryGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return out?.trim() || null;
}

function gitError(error: unknown): Error {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail =
    typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim()}` : "";
  return new Error(`${String((error as Error).message ?? error)}${detail}`);
}

export async function openLocalMemoryRepo(
  directory: string,
): Promise<MemoryRepoBackend & { root: string }> {
  const top = await tryGit(directory, ["rev-parse", "--show-toplevel"]);
  if (!top?.trim()) {
    throw new Error(`Not a Git repository: ${directory}`);
  }
  const root = top.trim();
  const current = (
    await tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  )?.trim();
  const defaultRef = current || "main";

  return {
    root,
    defaultRef,

    async read(path, ref) {
      const sha = await revParse(root, ref);
      if (!sha) throw new Error(`Unknown ref: ${ref}`);
      try {
        return (await runGit(root, ["show", `${sha}:${path}`])).stdout;
      } catch {
        return null;
      }
    },

    async list({ path, ref }) {
      const sha = await revParse(root, ref);
      if (!sha) throw new Error(`Unknown ref: ${ref}`);
      const out = await runGit(root, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        sha,
        ...(path ? ["--", path] : []),
      ]);
      return out.stdout.split("\0").filter(Boolean);
    },

    async log({ path, ref, limit }): Promise<MemoryLogEntry[]> {
      const sha = await revParse(root, ref);
      if (!sha) throw new Error(`Unknown ref: ${ref}`);
      const out = await runGit(root, [
        "log",
        `-n${limit}`,
        `--format=${LOG_FORMAT}`,
        sha,
        ...(path ? ["--", path] : []),
      ]);
      return out.stdout
        .split("\x1e")
        .map((record) => record.replace(/^\n/, ""))
        .filter(Boolean)
        .map((record) => {
          const [sha, author, email, date, message] = record.split("\x1f");
          return {
            sha: sha ?? "",
            author: author ?? "",
            email: email ?? "",
            date: date ?? "",
            message: (message ?? "").trimEnd(),
          };
        });
    },

    async diff({ base, ref }): Promise<MemoryDiffEntry[]> {
      const baseSha = await revParse(root, base);
      const refSha = await revParse(root, ref);
      if (!baseSha || !refSha) throw new Error(`Unknown ref: ${base}/${ref}`);
      // Branch-diff semantics: changes on ref since it diverged from base.
      const range = `${baseSha}...${refSha}`;
      const numstat = await runGit(root, [
        "diff",
        "--no-renames",
        "--numstat",
        "-z",
        range,
      ]);
      const status = await runGit(root, [
        "diff",
        "--no-renames",
        "--name-status",
        "-z",
        range,
      ]);
      const states = new Map<string, string>();
      const statusParts = status.stdout.split("\0").filter(Boolean);
      for (let i = 0; i + 1 < statusParts.length; i += 2) {
        const code = statusParts[i] ?? "";
        const state =
          code === "A" ? "added" : code === "D" ? "deleted" : "modified";
        states.set(statusParts[i + 1] ?? "", state);
      }
      const entries: MemoryDiffEntry[] = [];
      for (const line of numstat.stdout.split("\0").filter(Boolean)) {
        const [added, deleted, path] = line.split("\t");
        if (!path) continue;
        const patch = await runGit(root, ["diff", range, "--", path]);
        entries.push({
          path,
          state: states.get(path) ?? "modified",
          additions: Number(added) || 0,
          deletions: Number(deleted) || 0,
          patch: patch.stdout,
        });
      }
      return entries;
    },

    commit: (request) => commitLocal(root, request),
  };
}

async function commitLocal(
  root: string,
  request: MemoryCommitRequest,
): Promise<MemoryCommitResult> {
  return withMemoryOperation(root, async () => {
    const branchRef = `refs/heads/${request.branch}`;
    const branchSha = await revParse(root, branchRef);
    const start = branchSha ?? (await revParse(root, request.base));
    if (!start) throw new Error(`Unknown base ref: ${request.base}`);

    const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-commit-"));
    const worktree = join(tempDir, "worktree");
    let sha: string;
    try {
      await runGit(root, ["worktree", "add", "--detach", worktree, start]);
      for (const change of request.changes) {
        const file = join(worktree, change.path);
        if (change.kind === "put") {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, change.content, "utf8");
        } else {
          await rm(file, { recursive: true, force: true });
        }
      }
      const paths = [...new Set(request.changes.map((change) => change.path))];
      await runGit(worktree, ["add", "-A", "--", ...paths]);
      if ((await tryGit(worktree, ["diff", "--cached", "--quiet"])) !== null) {
        return { sha: start, branch: request.branch, changed: false };
      }
      try {
        await runGit(worktree, [
          "-c",
          `user.name=${request.author.name}`,
          "-c",
          `user.email=${request.author.email}`,
          "commit",
          "-m",
          request.message,
        ]);
      } catch (error) {
        throw gitError(error);
      }
      sha = (await runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    } finally {
      await tryGit(root, ["worktree", "remove", "--force", worktree]);
      rmSync(tempDir, { recursive: true, force: true });
    }

    const checkedOut = (
      await tryGit(root, ["symbolic-ref", "--quiet", "HEAD"])
    )?.trim();
    if (checkedOut === branchRef) {
      // Updates the working tree; Git refuses if uncommitted edits overlap.
      try {
        await runGit(root, ["merge", "--ff-only", sha]);
      } catch {
        try {
          await runGit(root, [
            "merge",
            "--no-edit",
            "-m",
            `merge(memory): ${request.message.split("\n")[0]}`,
            sha,
          ]);
        } catch (error) {
          await tryGit(root, ["merge", "--abort"]);
          throw new Error(
            `Commit ${sha} could not be merged into checked-out ${request.branch}; resolve the conflicting local edits and merge it manually. ${gitError(error).message}`,
          );
        }
      }
      sha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    } else {
      try {
        await runGit(root, [
          "update-ref",
          branchRef,
          sha,
          branchSha ?? ZERO_SHA,
        ]);
      } catch (error) {
        throw gitError(error);
      }
    }
    return { sha, branch: request.branch, changed: true };
  });
}
