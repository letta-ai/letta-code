import { existsSync } from "node:fs";
import { cp, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAuthToken } from "@/agent/memory-auth";
import { clearMemoryConflictRepair } from "@/agent/memory-conflict-repair";
import { validateMemoryConstraintsRevision } from "@/agent/memory-constraints-audit";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  getGitRemoteUrl,
  getMemoryConflictSummary,
  runGit,
  runGitWithRetry,
} from "@/agent/memory-git";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { getBackend } from "@/backend";

/** Explicitly discard local changes, not hosted memory. The CLI requires --force. */
export async function resetMemoryToRemote(agentId: string): Promise<{
  memoryDir: string;
  backupPath: string;
  revision: string;
}> {
  if (!getBackend().capabilities.remoteMemfs) {
    throw new Error(
      "Memory reset requires hosted memory; the local backend has no remote to restore.",
    );
  }
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  const gitDir = await getMemoryGitDir(memoryDir);
  const { stdout: topLevel } = await runGit(memoryDir, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (
    !(await lstat(join(memoryDir, ".git"))).isDirectory() ||
    gitDir !== (await realpath(join(memoryDir, ".git"))) ||
    (await realpath(topLevel.trim())) !== (await realpath(memoryDir))
  ) {
    throw new Error(
      "Memory reset requires a standalone memory checkout, not a linked worktree.",
    );
  }
  const release = await claimMemoryOperation(memoryDir);
  if (!release)
    throw new Error(
      "Cannot reset while another memory operation is active. Wait for it to finish.",
    );
  try {
    // Fetch the canonical hosted repository, not a stale or customized origin.
    // Nothing below changes the working tree/index until fetch and audit succeed.
    const remote = getGitRemoteUrl(agentId);
    await runGitWithRetry(
      memoryDir,
      ["fetch", "--no-tags", remote, "refs/heads/main"],
      await getAuthToken(),
    );
    const { stdout } = await runGit(memoryDir, [
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    const revision = stdout.trim();
    const validation = validateMemoryConstraintsRevision(memoryDir, revision);
    if (!validation.valid)
      throw new Error(
        `Hosted memory fails validation; local memory was not reset:\n${validation.output}`,
      );

    const backupPath = await mkdtemp(
      join(dirname(memoryDir), "memory-backup-reset-"),
    );
    try {
      await cp(memoryDir, backupPath, {
        recursive: true,
        verbatimSymlinks: true,
      });
    } catch (error) {
      await rm(backupPath, { recursive: true, force: true });
      throw error;
    }
    // A restored backup must not inherit this command's live lease.
    await rm(join(backupPath, ".git", "letta-memory-operation.lock"), {
      force: true,
    });
    await rm(join(backupPath, ".git", "letta-memory-repair.json.lock"), {
      force: true,
    });
    try {
      if (
        existsSync(join(gitDir, "rebase-merge")) ||
        existsSync(join(gitDir, "rebase-apply"))
      ) {
        await runGit(memoryDir, ["rebase", "--quit"]);
      }
      if (existsSync(join(gitDir, "MERGE_HEAD")))
        await runGit(memoryDir, ["merge", "--quit"]);
      if (
        existsSync(join(gitDir, "CHERRY_PICK_HEAD")) ||
        existsSync(join(gitDir, "REVERT_HEAD")) ||
        existsSync(join(gitDir, "sequencer"))
      ) {
        await runGit(memoryDir, ["cherry-pick", "--quit"]);
      }
      await runGit(memoryDir, ["checkout", "--force", "-B", "main", revision]);
      await runGit(memoryDir, ["clean", "-ffdx"]);
      const { stdout: remotes } = await runGit(memoryDir, ["remote"]);
      await runGit(
        memoryDir,
        remotes.trim().split("\n").includes("origin")
          ? ["remote", "set-url", "origin", remote]
          : ["remote", "add", "origin", remote],
      );
      await runGit(memoryDir, [
        "update-ref",
        "refs/remotes/origin/main",
        revision,
      ]);
      await runGit(memoryDir, [
        "branch",
        "--set-upstream-to",
        "origin/main",
        "main",
      ]);
      await clearMemoryConflictRepair(memoryDir, null);
      if (existsSync(join(gitDir, "letta-memory-repair.json"))) {
        throw new Error("Could not clear the previous memory repair attempt.");
      }
      const { stdout: status } = await runGit(memoryDir, [
        "status",
        "--porcelain",
      ]);
      const { stdout: head } = await runGit(memoryDir, ["rev-parse", "HEAD"]);
      if (
        status.trim() ||
        head.trim() !== revision ||
        (await getMemoryConflictSummary(memoryDir, status))
      ) {
        throw new Error(
          "Memory checkout is not clean at the fetched revision.",
        );
      }
      return { memoryDir, backupPath, revision };
    } catch (error) {
      throw new Error(
        `Memory reset did not finish. Original local state is backed up at ${backupPath}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await release();
  }
}
