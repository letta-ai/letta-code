/**
 * Memory handles over Letta-hosted repositories. Reads and branch writes go
 * through the Pierre SDK pointed at Letta's authenticated REST proxy, which
 * mints repository-scoped credentials server-side. The proxy refuses writes
 * to an agent's primary memory default branch, so those take the validated
 * Git route instead: a shallow clone, the MemFS pre-commit hook, and a push
 * to `/v1/git/<agent>/state.git`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError, GitStorage, type Repo } from "@pierre/storage";
import { getAuthToken } from "@/agent/memory-auth";
import {
  getGitRemoteUrl,
  isNonFastForwardPushError,
  runGit,
} from "@/agent/memory-git";
import { installPreCommitHook } from "@/agent/memory-git-hooks";
import { getServerUrl } from "@/backend/api/server-url";
import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryDiffEntry,
  MemoryLogEntry,
  MemoryPromoteRequest,
  MemoryRepoBackend,
} from "./types";

const DEFAULT_BRANCH = "main";
const LIST_PAGE_LIMIT = 1000;
const CLONE_TIMEOUT_MS = 180_000;

function proxyBaseUrl(agentId: string): string {
  const base = getServerUrl().replace(/\/+$/, "");
  return `${base}/v1/agents/${encodeURIComponent(agentId)}/memory/pierre`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function branchExists(repo: Repo, branch: string): Promise<boolean> {
  try {
    await repo.listCommits({ branch, limit: 1 });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function openRemoteMemoryRepo(
  agentId: string,
): Promise<MemoryRepoBackend> {
  const token = await getAuthToken();
  if (!token) {
    throw new Error(
      "Hosted memory requires Letta authentication; none is configured.",
    );
  }
  const storage = new GitStorage({
    name: "letta",
    token,
    apiBaseUrl: proxyBaseUrl(agentId),
  });
  // The proxy route pins the authorized repository; this id is ignored.
  const repo = storage.repo({
    id: agentId,
    defaultBranch: DEFAULT_BRANCH,
  });

  return {
    defaultRef: DEFAULT_BRANCH,

    async read(path, ref) {
      try {
        return await (await repo.getFileStream({ path, ref })).text();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async list({ path, ref }) {
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repo.listFiles({
          ref,
          ...(path ? { path } : {}),
          recursive: true,
          limit: LIST_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        paths.push(...page.paths);
        cursor = page.hasMore ? page.nextCursor : undefined;
      } while (cursor);
      return paths;
    },

    async log({ path, ref, limit }): Promise<MemoryLogEntry[]> {
      const { commits } = await repo.listCommits({
        branch: ref,
        limit,
        ...(path ? { path } : {}),
      });
      return commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message.trimEnd(),
        author: commit.authorName,
        email: commit.authorEmail,
        date: commit.rawDate,
      }));
    },

    async diff({ base, ref }): Promise<MemoryDiffEntry[]> {
      const { files } = await repo.getBranchDiff({ branch: ref, base });
      return files.map((file) => ({
        path: file.path,
        state: file.state,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.raw,
      }));
    },

    async commit(request) {
      if (request.branch === DEFAULT_BRANCH) {
        return commitAgentMainViaGit(agentId, token, request);
      }
      if (!(await branchExists(repo, request.branch))) {
        await repo.createBranch({
          baseRef: request.base,
          targetBranch: request.branch,
        });
      }
      let builder = repo.createCommit({
        targetBranch: request.branch,
        commitMessage: request.message,
        author: request.author,
      });
      for (const change of request.changes) {
        builder =
          change.kind === "put"
            ? builder.addFileFromString(change.path, change.content)
            : builder.deletePath(change.path);
      }
      const result = await builder.send();
      return { sha: result.commitSha, branch: request.branch, changed: true };
    },

    async promote(request) {
      if (request.branch !== DEFAULT_BRANCH) {
        throw new Error("promote() moves main only.");
      }
      return promoteAgentMainViaGit(agentId, token, request);
    },
  };
}

/**
 * The REST proxy refuses merges into an agent's main, so promotion pushes
 * over the validated Git route. A non-force push is the compare-and-swap:
 * the server rejects it as non-fast-forward once main has moved.
 */
async function promoteAgentMainViaGit(
  agentId: string,
  token: string,
  request: MemoryPromoteRequest,
): Promise<MemoryCommitResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-promote-"));
  try {
    const remote = getGitRemoteUrl(agentId);
    await runGit(tempDir, ["init", "-q"]);
    await runGit(
      tempDir,
      [
        "fetch",
        "-q",
        remote,
        `+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`,
        `+refs/heads/${request.ref}:refs/remotes/origin/source`,
      ],
      token,
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
    const sha = async (ref: string) =>
      (await runGit(tempDir, ["rev-parse", ref])).stdout.trim();
    const current = await sha(`refs/remotes/origin/${DEFAULT_BRANCH}`);
    const source = await sha("refs/remotes/origin/source");
    if (current !== request.expect) {
      throw new Error(
        `${DEFAULT_BRANCH} moved to ${current.slice(0, 12)}, not the expected ${request.expect.slice(0, 12)}; re-apply onto the new head.`,
      );
    }
    try {
      await runGit(tempDir, [
        "merge-base",
        "--is-ancestor",
        request.expect,
        source,
      ]);
    } catch {
      throw new Error(
        `${request.ref} does not descend from ${request.expect.slice(0, 12)}; re-apply onto ${DEFAULT_BRANCH}.`,
      );
    }
    const names = await runGit(tempDir, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      current,
      source,
    ]);
    await request.authorize(names.stdout.split("\0").filter(Boolean));
    if (source === current) {
      return { sha: source, branch: DEFAULT_BRANCH, changed: false };
    }
    try {
      await runGit(
        tempDir,
        ["push", remote, `${source}:refs/heads/${DEFAULT_BRANCH}`],
        token,
      );
    } catch (error) {
      if (isNonFastForwardPushError(error)) {
        throw new Error(
          `${DEFAULT_BRANCH} moved past ${request.expect.slice(0, 12)} during promotion; re-apply onto the new head.`,
        );
      }
      throw error;
    }
    return { sha: source, branch: DEFAULT_BRANCH, changed: true };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function commitAgentMainViaGit(
  agentId: string,
  token: string,
  request: MemoryCommitRequest,
): Promise<MemoryCommitResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-memory-push-"));
  const dir = join(tempDir, "repo");
  try {
    await runGit(
      tempDir,
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        DEFAULT_BRANCH,
        getGitRemoteUrl(agentId),
        dir,
      ],
      token,
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
    installPreCommitHook(dir, true);
    for (const change of request.changes) {
      const file = join(dir, change.path);
      if (change.kind === "put") {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, change.content, "utf8");
      } else {
        await rm(file, { recursive: true, force: true });
      }
    }
    const paths = [...new Set(request.changes.map((change) => change.path))];
    await runGit(dir, ["add", "-A", "--", ...paths]);
    const staged = await runGit(dir, ["diff", "--cached", "--name-only"]);
    if (!staged.stdout.trim()) {
      const head = await runGit(dir, ["rev-parse", "HEAD"]);
      return {
        sha: head.stdout.trim(),
        branch: DEFAULT_BRANCH,
        changed: false,
      };
    }
    // The fresh clone has no identity; the rebase below commits too.
    const identity = [
      "-c",
      `user.name=${request.author.name}`,
      "-c",
      `user.email=${request.author.email}`,
    ];
    await runGit(dir, [...identity, "commit", "-m", request.message]);
    const push = () =>
      runGit(dir, ["push", "origin", `HEAD:${DEFAULT_BRANCH}`], token);
    try {
      await push();
    } catch (error) {
      if (!isNonFastForwardPushError(error)) throw error;
      // Someone else advanced main; replay this one commit on top once.
      // `--onto ... HEAD~1` keeps the shallow boundary commit out of the replay.
      await runGit(
        dir,
        ["fetch", "--depth", "1", "origin", DEFAULT_BRANCH],
        token,
      );
      await runGit(dir, [
        ...identity,
        "rebase",
        "--onto",
        "FETCH_HEAD",
        "HEAD~1",
      ]);
      await push();
    }
    const head = await runGit(dir, ["rev-parse", "HEAD"]);
    return { sha: head.stdout.trim(), branch: DEFAULT_BRANCH, changed: true };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
