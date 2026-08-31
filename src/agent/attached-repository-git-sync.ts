import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBackend } from "@/backend";
import {
  type AttachedAgentRepository,
  listAttachedAgentRepositories,
} from "./attached-repositories";
import {
  getAuthToken,
  getMemoryAheadBehind,
  getMemoryConflictSummary,
  getRepositoryMountDir,
  getRepositoryRemoteUrl,
  isNonFastForwardPushError,
  type MemoryPostTurnSyncStatus,
  prepareAttachedRepositoryForGitOps,
  runGit,
  runGitWithRetry,
} from "./memory-git";

export interface RepositoryPostTurnSyncResult {
  name: string;
  path: string;
  permissions: string;
  status: MemoryPostTurnSyncStatus;
  summary: string;
}

export interface RepositoriesPostTurnSyncResult {
  results: RepositoryPostTurnSyncResult[];
}

export interface SyncPendingAttachedRepositoryParams {
  agentId: string;
  repository: AttachedAgentRepository;
  token: string;
  remoteSupported: boolean;
  localOnly: boolean;
  mountDir?: string;
  remoteUrl?: string;
}

const repositorySyncs = new Map<
  string,
  Promise<RepositoryPostTurnSyncResult>
>();

async function getPendingCommitCount(path: string): Promise<number> {
  const divergence = await getMemoryAheadBehind(path);
  if (divergence) {
    return divergence.ahead;
  }

  try {
    await runGit(path, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return 0;
  }

  try {
    const { stdout } = await runGit(path, [
      "rev-list",
      "--count",
      "refs/remotes/origin/main..HEAD",
    ]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    const { stdout } = await runGit(path, ["rev-list", "--count", "HEAD"]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  }
}

async function syncPendingAttachedRepositoryCommitsUnlocked(
  params: SyncPendingAttachedRepositoryParams,
): Promise<RepositoryPostTurnSyncResult> {
  const path =
    params.mountDir ??
    getRepositoryMountDir(params.agentId, params.repository.name);
  const resultBase = {
    name: params.repository.name,
    path,
    permissions: params.repository.permissions ?? "unknown",
  };

  if (!existsSync(join(path, ".git"))) {
    return {
      ...resultBase,
      status: "skipped",
      summary: "Repository is not mounted.",
    };
  }

  const { stdout: statusOut } = await runGit(path, ["status", "--porcelain"]);
  const conflictSummary = await getMemoryConflictSummary(path, statusOut);
  if (conflictSummary) {
    return {
      ...resultBase,
      status: "conflict",
      summary: conflictSummary,
    };
  }

  if (statusOut.trim().length > 0) {
    const changedCount = statusOut
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    if (params.repository.permissions !== "read_write") {
      return {
        ...resultBase,
        status: "push_failed",
        summary: `Repository is read-only with ${changedCount} uncommitted change(s) that cannot be pushed.`,
      };
    }
    return {
      ...resultBase,
      status: "dirty",
      summary: `${changedCount} uncommitted shared-memory change(s).`,
    };
  }

  const pendingCommitCount = await getPendingCommitCount(path);
  if (pendingCommitCount <= 0) {
    return {
      ...resultBase,
      status: "clean",
      summary: "Repository is clean and has no pending commits to push.",
    };
  }

  if (params.repository.permissions !== "read_write") {
    return {
      ...resultBase,
      status: "push_failed",
      summary: `Repository is read-only with ${pendingCommitCount} local commit(s) that cannot be pushed.`,
    };
  }

  if (!params.remoteSupported) {
    return {
      ...resultBase,
      status: "push_failed",
      summary: params.localOnly
        ? "Local backend has no Letta remote to push."
        : "Active backend does not support remote repository pushes.",
    };
  }

  const remoteUrl =
    params.remoteUrl ??
    getRepositoryRemoteUrl(params.agentId, params.repository.name);
  await prepareAttachedRepositoryForGitOps({
    agentId: params.agentId,
    repositoryName: params.repository.name,
    directory: path,
    remoteUrl,
    token: params.token,
  });

  try {
    await runGitWithRetry(
      path,
      ["push", "-u", "origin", "HEAD:main"],
      params.token,
      {
        operation: `post-turn push shared memory ${params.repository.name}`,
      },
    );
    return {
      ...resultBase,
      status: "pushed",
      summary: `Pushed ${pendingCommitCount} pending shared-memory commit(s).`,
    };
  } catch (pushError) {
    if (!isNonFastForwardPushError(pushError)) {
      return {
        ...resultBase,
        status: "push_failed",
        summary:
          pushError instanceof Error ? pushError.message : String(pushError),
      };
    }
  }

  try {
    await runGitWithRetry(
      path,
      ["pull", "--rebase", "origin", "main"],
      params.token,
      {
        operation: `post-turn rebase shared memory ${params.repository.name}`,
      },
    );
    const postRebaseConflictSummary = await getMemoryConflictSummary(path);
    if (postRebaseConflictSummary) {
      return {
        ...resultBase,
        status: "conflict",
        summary: postRebaseConflictSummary,
      };
    }
    await runGitWithRetry(
      path,
      ["push", "-u", "origin", "HEAD:main"],
      params.token,
      {
        operation: `post-turn push rebased shared memory ${params.repository.name}`,
      },
    );
    return {
      ...resultBase,
      status: "pushed",
      summary: `Rebased and pushed ${pendingCommitCount} pending shared-memory commit(s).`,
    };
  } catch (rebaseOrPushError) {
    const postFailureConflictSummary = await getMemoryConflictSummary(path);
    if (postFailureConflictSummary) {
      return {
        ...resultBase,
        status: "conflict",
        summary: postFailureConflictSummary,
      };
    }
    return {
      ...resultBase,
      status: "push_failed",
      summary:
        rebaseOrPushError instanceof Error
          ? rebaseOrPushError.message
          : String(rebaseOrPushError),
    };
  }
}

export function syncPendingAttachedRepositoryCommits(
  params: SyncPendingAttachedRepositoryParams,
): Promise<RepositoryPostTurnSyncResult> {
  const path =
    params.mountDir ??
    getRepositoryMountDir(params.agentId, params.repository.name);
  const previous = repositorySyncs.get(path) ?? Promise.resolve(null);
  const current = previous
    .catch(() => null)
    .then(() => syncPendingAttachedRepositoryCommitsUnlocked(params));
  repositorySyncs.set(path, current);
  return current.finally(() => {
    if (repositorySyncs.get(path) === current) {
      repositorySyncs.delete(path);
    }
  });
}

export async function syncPendingAttachedRepositoryCommitsAfterTurn(
  agentId: string,
): Promise<RepositoriesPostTurnSyncResult> {
  const backend = getBackend();
  const localOnly =
    backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs;
  const repositories = await listAttachedAgentRepositories(agentId);
  if (repositories.length === 0) {
    return { results: [] };
  }

  const token = await getAuthToken();
  const settledResults = await Promise.allSettled(
    repositories.map((repository) =>
      syncPendingAttachedRepositoryCommits({
        agentId,
        repository,
        token,
        remoteSupported: backend.capabilities.remoteMemfs,
        localOnly,
      }),
    ),
  );

  return {
    results: settledResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const repository = repositories[index];
      return {
        name: repository?.name ?? "unknown",
        path: repository ? getRepositoryMountDir(agentId, repository.name) : "",
        permissions: repository?.permissions ?? "unknown",
        status: "push_failed",
        summary:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }),
  };
}
