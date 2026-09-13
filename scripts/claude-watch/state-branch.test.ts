import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_WATCH_STATE_BRANCH,
  CLAUDE_WATCH_STATE_FILE,
  finalizeStateBranch,
  loadStateSnapshot,
  loadStateSnapshotAtCommit,
  materializeStateFiles,
  resolveStateBranchTip,
} from "./state-branch.ts";
import {
  CLAUDE_WATCH_STATE_SCHEMA_VERSION,
  type ClaudeWatchStateSnapshot,
} from "./types.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function snapshot(candidateId: string): ClaudeWatchStateSnapshot {
  return {
    schema_version: CLAUDE_WATCH_STATE_SCHEMA_VERSION,
    candidate_id: candidateId,
    package_version: candidateId,
    npm_integrity: `sha512-${candidateId}`,
    npm_published_at: "2026-08-01T00:00:00Z",
    release_url: `https://example.test/releases/${candidateId}`,
    release_notes_md: "release notes",
    release_published_at: "2026-08-01T00:00:00Z",
    dist_tags: { latest: candidateId, stable: candidateId, next: null },
    docs: {
      index_url: "https://example.test/docs",
      index_hash: "index-hash",
      digest: `docs-${candidateId}`,
      full_scan: true,
      scanned_at: "2026-08-01T00:00:00Z",
      pages: {},
    },
    runtime: null,
    fetched_at: "2026-08-01T00:00:00Z",
    workflow_run_url: "https://example.test/actions/1",
    state_commit_parent: null,
    analysis_parent_sha: null,
  };
}

function repository(): { root: string; remote: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-state-test-"));
  const remote = join(root, "remote.git");
  const clone = join(root, "clone");
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, clone);
  git(clone, "checkout", "-b", "main");
  git(clone, "commit", "--allow-empty", "-m", "initial main");
  git(clone, "push", "-u", "origin", "main");
  return { root, remote, clone };
}

describe("Claude state branch", () => {
  test("materializes and safely loads a deterministic snapshot", () => {
    const value = snapshot("2.1.0");
    const files = materializeStateFiles(value, {
      "runtime/output.json": "{}\n",
      "docs/index.json": "[]\n",
      [CLAUDE_WATCH_STATE_FILE]: "must be replaced",
    });
    expect(Object.keys(files)).toEqual([
      "docs/index.json",
      "runtime/output.json",
      CLAUDE_WATCH_STATE_FILE,
    ]);
    expect(loadStateSnapshot(files)).toEqual(value);
    expect(loadStateSnapshot({ [CLAUDE_WATCH_STATE_FILE]: "{" })).toBeNull();
    expect(() => materializeStateFiles(value, { "../escape": "no" })).toThrow(
      "Unsafe state file path",
    );
  });

  test("creates an orphan state branch, advances by parent, and is idempotent", () => {
    const repo = repository();
    try {
      const mainBefore = git(repo.clone, "rev-parse", "main");
      const first = finalizeStateBranch({
        repoPath: repo.clone,
        snapshot: snapshot("2.1.0"),
        files: { "docs/page.txt": "first\n" },
        expectedBaseSha: null,
      });
      expect(first.created).toBe(true);
      expect(first.parentSha).toBeNull();
      expect(
        git(repo.clone, "rev-list", "--parents", "-n", "1", first.commitSha),
      ).toBe(first.commitSha);
      expect(resolveStateBranchTip(repo.clone)).toBe(first.commitSha);
      expect(
        loadStateSnapshotAtCommit(repo.clone, first.commitSha),
      ).toMatchObject({
        candidate_id: "2.1.0",
        state_commit_parent: null,
      });

      const retry = finalizeStateBranch({
        repoPath: repo.clone,
        snapshot: snapshot("2.1.0"),
        expectedBaseSha: null,
      });
      expect(retry).toEqual({
        commitSha: first.commitSha,
        created: false,
        parentSha: first.commitSha,
      });

      const second = finalizeStateBranch({
        repoPath: repo.clone,
        snapshot: snapshot("2.2.0"),
        expectedBaseSha: first.commitSha,
      });
      expect(second.parentSha).toBe(first.commitSha);
      expect(
        git(repo.clone, "rev-list", "--parents", "-n", "1", second.commitSha),
      ).toBe(`${second.commitSha} ${first.commitSha}`);
      expect(
        loadStateSnapshotAtCommit(repo.clone, second.commitSha),
      ).toMatchObject({
        candidate_id: "2.2.0",
        state_commit_parent: first.commitSha,
        analysis_parent_sha: null,
      });
      expect(git(repo.clone, "rev-parse", "main")).toBe(mainBefore);
      expect(git(repo.clone, "branch", "--show-current")).toBe("main");
      expect(
        git(repo.clone, "ls-remote", "--heads", "origin", "main"),
      ).toContain(mainBefore);
      expect(
        git(
          repo.clone,
          "ls-remote",
          "--heads",
          "origin",
          CLAUDE_WATCH_STATE_BRANCH,
        ),
      ).toContain(second.commitSha);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("rejects a stale base for a different candidate", () => {
    const repo = repository();
    try {
      const first = finalizeStateBranch({
        repoPath: repo.clone,
        snapshot: snapshot("2.1.0"),
        expectedBaseSha: null,
      });
      expect(() =>
        finalizeStateBranch({
          repoPath: repo.clone,
          snapshot: snapshot("2.2.0"),
          expectedBaseSha: null,
        }),
      ).toThrow(`found ${first.commitSha}`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("a rejected push leaves main and the durable state tip unchanged", () => {
    const repo = repository();
    try {
      const first = finalizeStateBranch({
        repoPath: repo.clone,
        snapshot: snapshot("2.1.0"),
        expectedBaseSha: null,
      });
      const mainBefore = git(repo.clone, "rev-parse", "main");
      const hook = join(repo.remote, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n");
      chmodSync(hook, 0o755);

      expect(() =>
        finalizeStateBranch({
          repoPath: repo.clone,
          snapshot: snapshot("2.2.0"),
          expectedBaseSha: first.commitSha,
        }),
      ).toThrow("rejected");
      expect(resolveStateBranchTip(repo.clone)).toBe(first.commitSha);
      expect(git(repo.clone, "rev-parse", "main")).toBe(mainBefore);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
