import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPendingAttachedRepositoryCommits } from "./attached-repository-git-sync";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureIdentity(repo: string): void {
  git(repo, ["config", "user.name", "Shared Memory Test"]);
  git(repo, ["config", "user.email", "shared-memory-test@letta.com"]);
}

function makeRepositoryFixture(): {
  root: string;
  remote: string;
  mount: string;
  peer: string;
} {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-sync-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const mount = join(root, "mount");
  const peer = join(root, "peer");

  git(root, ["init", "--bare", remote]);
  git(root, ["init", "--initial-branch=main", seed]);
  configureIdentity(seed);
  writeFileSync(join(seed, "MEMORY.md"), "# Shared memory\n", "utf8");
  git(seed, ["add", "MEMORY.md"]);
  git(seed, ["commit", "-m", "initialize shared memory"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(root, ["clone", remote, mount]);
  configureIdentity(mount);
  git(root, ["clone", remote, peer]);
  configureIdentity(peer);
  return { root, remote, mount, peer };
}

function makeEmptyRepositoryFixture(): {
  root: string;
  remote: string;
  mount: string;
} {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-empty-sync-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const mount = join(root, "mount");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "--initial-branch=main", mount]);
  configureIdentity(mount);
  git(mount, ["remote", "add", "origin", remote]);
  return { root, remote, mount };
}

function commitFile(repo: string, path: string, content: string): string {
  writeFileSync(join(repo, path), content, "utf8");
  git(repo, ["add", path]);
  git(repo, ["commit", "-m", `update ${path}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function syncFixture(
  fixture: ReturnType<typeof makeRepositoryFixture>,
  permissions = "read_write",
) {
  return syncPendingAttachedRepositoryCommits({
    agentId: "agent-shared-memory-test",
    repository: {
      id: "repo-shared-memory-test",
      name: "shared-notes",
      permissions,
    },
    token: "",
    remoteSupported: true,
    localOnly: false,
    mountDir: fixture.mount,
    remoteUrl: fixture.remote,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncPendingAttachedRepositoryCommits", () => {
  test("pushes clean committed shared-memory changes", async () => {
    const fixture = makeRepositoryFixture();
    const localSha = commitFile(fixture.mount, "notes.md", "local notes\n");

    const result = await syncFixture(fixture);

    expect(result.status).toBe("pushed");
    expect(git(fixture.mount, ["rev-list", "--count", "@{u}..HEAD"])).toBe("0");
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(localSha);
  });

  test("pushes the first commit when the remote has no branch", async () => {
    const fixture = makeEmptyRepositoryFixture();
    const localSha = commitFile(fixture.mount, "MEMORY.md", "# First commit\n");

    const result = await syncFixture({ ...fixture, peer: fixture.mount });

    expect(result.status).toBe("pushed");
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(localSha);
    expect(git(fixture.mount, ["rev-parse", "@{u}"])).toBe(localSha);
  });

  test("leaves uncommitted changes for the agent to review", async () => {
    const fixture = makeRepositoryFixture();
    const remoteSha = git(fixture.remote, ["rev-parse", "main"]);
    writeFileSync(join(fixture.mount, "draft.md"), "not committed\n", "utf8");

    const result = await syncFixture(fixture);

    expect(result.status).toBe("dirty");
    expect(result.summary).toContain("1 uncommitted");
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(remoteSha);
  });

  test("rebases and pushes when another agent wrote first", async () => {
    const fixture = makeRepositoryFixture();
    commitFile(fixture.mount, "local.md", "from local agent\n");
    commitFile(fixture.peer, "peer.md", "from peer agent\n");
    git(fixture.peer, ["push", "origin", "main"]);

    const result = await syncFixture(fixture);

    expect(result.status).toBe("pushed");
    expect(result.summary).toContain("Rebased and pushed");
    const remoteFiles = git(fixture.remote, [
      "ls-tree",
      "--name-only",
      "-r",
      "main",
    ]).split("\n");
    expect(remoteFiles).toContain("local.md");
    expect(remoteFiles).toContain("peer.md");
  });

  test("serializes overlapping syncs for the same mount", async () => {
    const fixture = makeRepositoryFixture();
    commitFile(fixture.mount, "local.md", "one pending commit\n");

    const results = await Promise.all([
      syncFixture(fixture),
      syncFixture(fixture),
    ]);

    expect(results.map((result) => result.status)).toEqual(["pushed", "clean"]);
    expect(git(fixture.mount, ["rev-list", "--count", "@{u}..HEAD"])).toBe("0");
  });

  test("does not push commits from a read-only attachment", async () => {
    const fixture = makeRepositoryFixture();
    const remoteSha = git(fixture.remote, ["rev-parse", "main"]);
    commitFile(fixture.mount, "local.md", "cannot publish\n");

    const result = await syncFixture(fixture, "read_only");

    expect(result.status).toBe("push_failed");
    expect(result.summary).toContain("read-only with 1 local commit");
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(remoteSha);
  });

  test("does not tell the agent to commit dirty read-only files", async () => {
    const fixture = makeRepositoryFixture();
    writeFileSync(join(fixture.mount, "draft.md"), "cannot publish\n", "utf8");

    const result = await syncFixture(fixture, "read_only");

    expect(result.status).toBe("push_failed");
    expect(result.summary).toContain("read-only with 1 uncommitted change");
  });
});
