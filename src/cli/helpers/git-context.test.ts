import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGithubRepositoryHandoffForDirectory,
  parseGithubRepositoryRemote,
} from "./git-context";

describe("parseGithubRepositoryRemote", () => {
  test("parses GitHub HTTPS and SSH remotes", () => {
    expect(
      parseGithubRepositoryRemote("https://github.com/letta-ai/letta-code.git"),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
    expect(
      parseGithubRepositoryRemote("git@github.com:letta-ai/letta-code.git"),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
    expect(
      parseGithubRepositoryRemote(
        "ssh://git@github.com/letta-ai/letta-code.git",
      ),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
  });

  test("rejects non-GitHub remotes", () => {
    expect(
      parseGithubRepositoryRemote("https://gitlab.com/letta-ai/letta-code.git"),
    ).toBeNull();
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("getGithubRepositoryHandoffForDirectory", () => {
  test("requires clean, pushed state and captures the exact branch commit", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-cloud-handoff-"));
    const bare = join(root, "remote.git");
    const repo = join(root, "repo");
    git(root, ["init", "--bare", bare]);
    git(root, ["clone", bare, repo]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["branch", "-M", "feature/handoff"]);
    git(repo, ["push", "-u", "origin", "feature/handoff"]);
    git(repo, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);

    expect(getGithubRepositoryHandoffForDirectory(repo)).toEqual({
      repository: {
        owner: "owner",
        repo: "repo",
        branch: "feature/handoff",
        ref: git(repo, ["rev-parse", "HEAD"]),
      },
      error: null,
    });

    writeFileSync(join(repo, "file.txt"), "dirty\n");
    expect(getGithubRepositoryHandoffForDirectory(repo).error).toContain(
      "uncommitted changes",
    );

    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-m", "unpushed"]);
    expect(getGithubRepositoryHandoffForDirectory(repo).error).toContain(
      "not pushed",
    );
  });
});
