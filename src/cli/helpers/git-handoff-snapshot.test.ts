import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateSnapshotCommit } from "./git-handoff-snapshot";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "letta-private-handoff-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("createPrivateSnapshotCommit", () => {
  test("captures the working tree without changing HEAD, branch, or real index", () => {
    const repo = createRepository();
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const branchBefore = git(repo, ["branch", "--show-current"]);

    writeFileSync(join(repo, "tracked.txt"), "staged\n");
    git(repo, ["add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "working tree\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    git(repo, ["add", "new.txt"]);
    const indexBefore = git(repo, ["show", ":tracked.txt"]);

    const snapshot = createPrivateSnapshotCommit(repo);

    expect(snapshot.changedFiles.sort()).toEqual(["new.txt", "tracked.txt"]);
    expect(git(repo, ["show", `${snapshot.commit}:tracked.txt`])).toBe(
      "working tree",
    );
    expect(git(repo, ["show", `${snapshot.commit}:new.txt`])).toBe("untracked");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(repo, ["branch", "--show-current"])).toBe(branchBefore);
    expect(git(repo, ["show", ":tracked.txt"])).toBe(indexBefore);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
      "working tree\n",
    );
  });

  test("leaves unstaged untracked files out of the snapshot", () => {
    const repo = createRepository();
    writeFileSync(join(repo, ".env.example"), "EXAMPLE=value\n");

    const snapshot = createPrivateSnapshotCommit(repo);

    expect(snapshot.changedFiles).toEqual([]);
    expect(() =>
      git(repo, ["show", `${snapshot.commit}:.env.example`]),
    ).toThrow();
  });

  test("includes an explicitly staged environment template", () => {
    const repo = createRepository();
    writeFileSync(join(repo, ".env.example"), "EXAMPLE=value\n");
    git(repo, ["add", ".env.example"]);

    const snapshot = createPrivateSnapshotCommit(repo);

    expect(snapshot.changedFiles).toEqual([".env.example"]);
    expect(git(repo, ["show", `${snapshot.commit}:.env.example`])).toBe(
      "EXAMPLE=value",
    );
  });

  test("refuses to include likely-secret files", () => {
    const repo = createRepository();
    writeFileSync(join(repo, ".env"), "SECRET=value\n");
    git(repo, ["add", ".env"]);
    expect(() => createPrivateSnapshotCommit(repo)).toThrow(
      "Refusing to snapshot likely-secret files",
    );
  });
});
