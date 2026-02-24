/**
 * Git-based memory storage for agents.
 *
 * This module provides version-controlled memory blocks using isomorphic-git.
 * Each agent gets their own git repository for full history, diff, merge, and rollback.
 *
 * Phase 1: Uses local filesystem (Node's fs module)
 * Phase 2: Swap fs adapter to S3 for production
 */

import { existsSync, mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import git from "isomorphic-git";

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: Date;
}

export interface DiffEntry {
  filepath: string;
  status: "added" | "modified" | "deleted";
  before: string | null;
  after: string | null;
}

export interface MergeConflict {
  filepath: string;
  ours: string;
  theirs: string;
  base: string | null;
}

export interface MergeResult {
  success: boolean;
  sha?: string;
  conflicts?: MergeConflict[];
}

/**
 * Git-based memory store for a single agent.
 *
 * Usage:
 * ```ts
 * const memoryGit = new AgentMemoryGit('/path/to/storage', 'agent-abc123');
 * await memoryGit.init();
 *
 * // Write memory blocks
 * await memoryGit.writeBlock('persona', '# Persona\nI am a helpful assistant.');
 * await memoryGit.writeBlock('human', '# Human\nName: Sarah');
 *
 * // Commit after agent turn
 * const sha = await memoryGit.commit('Turn 1: Updated persona');
 *
 * // Get history
 * const history = await memoryGit.log();
 *
 * // See what changed
 * const diff = await memoryGit.diff(history[1].sha, history[0].sha);
 *
 * // Rollback to previous state
 * await memoryGit.checkout(history[1].sha);
 * ```
 */
export class AgentMemoryGit {
  private dir: string;

  // For Phase 2: This will be swapped to an S3 filesystem adapter
  // The API stays exactly the same - just change this `fs` object
  private fs = {
    promises: fs,
    // isomorphic-git also needs these sync methods for some operations
    existsSync,
    mkdirSync,
  };

  constructor(storageRoot: string, agentId: string) {
    this.dir = join(storageRoot, "agents", agentId, "memory-git");
  }

  /** Get the repository directory path */
  getRepoPath(): string {
    return this.dir;
  }

  /** Initialize a new git repository for this agent */
  async init(): Promise<void> {
    // Create directory if it doesn't exist
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    // Check if already initialized
    const gitDir = join(this.dir, ".git");
    if (existsSync(gitDir)) {
      return; // Already initialized
    }

    // Initialize git repo
    await git.init({
      fs: this.fs,
      dir: this.dir,
      defaultBranch: "main",
    });

    // Create initial commit with empty .gitkeep
    await fs.writeFile(join(this.dir, ".gitkeep"), "");
    await git.add({ fs: this.fs, dir: this.dir, filepath: ".gitkeep" });
    await git.commit({
      fs: this.fs,
      dir: this.dir,
      message: "Initial commit",
      author: { name: "Letta", email: "system@letta.com" },
    });
  }

  /** Read a memory block */
  async readBlock(label: string): Promise<string | null> {
    const filepath = this.blockPath(label);
    try {
      const content = await fs.readFile(filepath, "utf-8");
      return content;
    } catch {
      return null;
    }
  }

  /** Write a memory block */
  async writeBlock(label: string, content: string): Promise<void> {
    const filepath = this.blockPath(label);
    const dir = join(this.dir, ...label.split("/").slice(0, -1));

    // Create parent directories if needed (for nested labels like "project/notes")
    if (label.includes("/") && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await fs.writeFile(filepath, content, "utf-8");
  }

  /** Delete a memory block */
  async deleteBlock(label: string): Promise<void> {
    const filepath = this.blockPath(label);
    try {
      await fs.unlink(filepath);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  /** List all memory blocks */
  async listBlocks(): Promise<string[]> {
    const files = await this.walkDir(this.dir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  /** Stage and commit all changes */
  async commit(
    message: string,
    author: string = "Letta Agent",
  ): Promise<string> {
    // Get all files in the working directory (excluding .git)
    const allFiles = await this.walkDir(this.dir);

    // Get what's currently tracked
    const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
    const trackedFiles = new Set(status.map((row) => row[0] as string));

    // Stage all current files (add will re-hash and detect changes)
    for (const filepath of allFiles) {
      if (filepath.startsWith(".git")) continue;
      await git.add({ fs: this.fs, dir: this.dir, filepath });
    }

    // Handle deletions: files that are tracked but no longer exist
    for (const filepath of trackedFiles) {
      if (filepath.startsWith(".git")) continue;
      if (!allFiles.includes(filepath)) {
        await git.remove({ fs: this.fs, dir: this.dir, filepath });
      }
    }

    // Check if there are actual changes to commit
    const newStatus = await git.statusMatrix({ fs: this.fs, dir: this.dir });
    const hasChanges = newStatus.some((row) => {
      const headStatus = row[1] as number;
      const stageStatus = row[3] as number;
      // Change exists if staged state differs from HEAD
      return headStatus !== stageStatus;
    });

    if (!hasChanges) {
      // No changes to commit, return current HEAD
      const head = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: "HEAD",
      });
      return head;
    }

    // Create commit
    const sha = await git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      author: {
        name: author,
        email: `${author.toLowerCase().replace(/\s+/g, ".")}@letta.com`,
      },
    });

    return sha;
  }

  /** Get commit history */
  async log(depth: number = 50): Promise<CommitInfo[]> {
    try {
      const commits = await git.log({ fs: this.fs, dir: this.dir, depth });
      return commits.map((c) => ({
        sha: c.oid,
        message: c.commit.message.trim(), // Git adds trailing newline to messages
        author: c.commit.author.name,
        timestamp: new Date(c.commit.author.timestamp * 1000),
      }));
    } catch {
      return [];
    }
  }

  /** Get current HEAD commit SHA */
  async getHead(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  /** Get diff between two commits */
  async diff(fromSha: string, toSha: string): Promise<DiffEntry[]> {
    const diffs: DiffEntry[] = [];

    // Read the commits to get their trees
    const fromCommit = await git.readCommit({
      fs: this.fs,
      dir: this.dir,
      oid: fromSha,
    });
    const toCommit = await git.readCommit({
      fs: this.fs,
      dir: this.dir,
      oid: toSha,
    });

    // Read the trees
    const fromTree = await git.readTree({
      fs: this.fs,
      dir: this.dir,
      oid: fromCommit.commit.tree,
    });
    const toTree = await git.readTree({
      fs: this.fs,
      dir: this.dir,
      oid: toCommit.commit.tree,
    });

    // Build maps for comparison
    const fromMap = new Map(
      fromTree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
    );
    const toMap = new Map(
      toTree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]),
    );

    // Get all unique paths
    const allPaths = new Set([...fromMap.keys(), ...toMap.keys()]);

    for (const filepath of allPaths) {
      const fromEntry = fromMap.get(filepath);
      const toEntry = toMap.get(filepath);

      // Same OID means no change
      if (fromEntry?.oid === toEntry?.oid) continue;

      // Read blob contents
      let before: string | null = null;
      let after: string | null = null;

      if (fromEntry) {
        const { blob } = await git.readBlob({
          fs: this.fs,
          dir: this.dir,
          oid: fromEntry.oid,
        });
        before = new TextDecoder().decode(blob);
      }

      if (toEntry) {
        const { blob } = await git.readBlob({
          fs: this.fs,
          dir: this.dir,
          oid: toEntry.oid,
        });
        after = new TextDecoder().decode(blob);
      }

      let status: "added" | "modified" | "deleted";
      if (!before && after) {
        status = "added";
      } else if (before && !after) {
        status = "deleted";
      } else {
        status = "modified";
      }

      diffs.push({ filepath, status, before, after });
    }

    return diffs;
  }

  /** Checkout a specific commit (detached HEAD) or branch */
  async checkout(ref: string): Promise<void> {
    await git.checkout({
      fs: this.fs,
      dir: this.dir,
      ref,
      force: true, // Overwrite local changes
    });
  }

  /** Create a new branch */
  async createBranch(name: string): Promise<void> {
    await git.branch({
      fs: this.fs,
      dir: this.dir,
      ref: name,
    });
  }

  /** List branches */
  async listBranches(): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir: this.dir });
  }

  /** Get current branch name */
  async currentBranch(): Promise<string | null> {
    try {
      return (await git.currentBranch({ fs: this.fs, dir: this.dir })) ?? null;
    } catch {
      return null;
    }
  }

  /** Merge another branch into current branch */
  async merge(
    theirBranch: string,
    author: string = "Letta",
  ): Promise<MergeResult> {
    try {
      const result = await git.merge({
        fs: this.fs,
        dir: this.dir,
        theirs: theirBranch,
        author: { name: author, email: `${author.toLowerCase()}@letta.com` },
      });

      return { success: true, sha: result.oid };
    } catch (err) {
      // Handle merge conflicts
      if (err instanceof Error && err.message.includes("conflict")) {
        // TODO: Extract conflict details
        return {
          success: false,
          conflicts: [], // Would need to parse conflict markers
        };
      }
      throw err;
    }
  }

  /** Get file content at a specific commit */
  async readBlockAt(label: string, commitSha: string): Promise<string | null> {
    try {
      // First, get the commit object to find its tree
      const { commit } = await git.readCommit({
        fs: this.fs,
        dir: this.dir,
        oid: commitSha,
      });

      // Read the blob from the commit's tree
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: commit.tree,
        filepath: `${label}.md`,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private blockPath(label: string): string {
    return join(this.dir, `${label}.md`);
  }

  private async walkDir(dir: string, base: string = ""): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const relativePath = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (entry.name === ".git") continue; // Skip .git
        files.push(
          ...(await this.walkDir(join(dir, entry.name), relativePath)),
        );
      } else {
        files.push(relativePath);
      }
    }

    return files;
  }
}
