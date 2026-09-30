import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAttachedRepositoryCheckout } from "./attached-repository-checkout";
import { findCaseCollidingTrackedPath } from "./memory-git-case-collisions";

const tempDirs: string[] = [];
const fixtureEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(
  cwd: string,
  args: string[],
  ignorecase = true,
  input?: string,
): string {
  return execFileSync(
    "git",
    [...(ignorecase ? ["-c", "core.ignorecase=true"] : []), ...args],
    { cwd, encoding: "utf8", env: fixtureEnv, input },
  );
}

function makeFixture(): { root: string; source: string; mount: string } {
  const root = mkdtempSync(join(tmpdir(), "memory-case-collision-"));
  tempDirs.push(root);
  const source = join(root, "source");
  const mount = join(root, "mount");
  git(root, ["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "MEMORY.md"), "# Fixture\n");
  git(source, ["add", "MEMORY.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  return { root, source, mount };
}

function makeEmptyFixture(): ReturnType<typeof makeFixture> {
  const root = mkdtempSync(join(tmpdir(), "empty-memory-repo-"));
  tempDirs.push(root);
  const source = join(root, "source");
  const mount = join(root, "mount");
  git(root, ["init", "-q", "-b", "main", source]);
  return { root, source, mount };
}

function addCaseVariants(source: string): void {
  // Build the remote tree as Git objects, not files: this fixture also works
  // when the test host itself cannot hold both directory spellings.
  const one = git(
    source,
    ["hash-object", "-w", "--stdin"],
    false,
    "# One\n",
  ).trim();
  const two = git(
    source,
    ["hash-object", "-w", "--stdin"],
    false,
    "# Two\n",
  ).trim();
  const upper = git(
    source,
    ["mktree"],
    false,
    `100644 blob ${one}\tone.md\n`,
  ).trim();
  const lower = git(
    source,
    ["mktree"],
    false,
    `100644 blob ${two}\ttwo.md\n`,
  ).trim();
  const memory = git(source, ["rev-parse", "HEAD:MEMORY.md"], false).trim();
  const tree = git(
    source,
    ["mktree"],
    false,
    `040000 tree ${upper}\tPDF\n040000 tree ${lower}\tpdf\n100644 blob ${memory}\tMEMORY.md\n`,
  ).trim();
  const parent = git(source, ["rev-parse", "HEAD"], false).trim();
  const commit = git(
    source,
    ["commit-tree", tree, "-p", parent, "-m", "case variants"],
    false,
  ).trim();
  git(source, ["update-ref", "refs/heads/main", commit, parent], false);
}

async function syncFixture(
  fixture: ReturnType<typeof makeFixture>,
  ignorecase = true,
  failHeadProbe = false,
): Promise<void> {
  await syncAttachedRepositoryCheckout(
    {
      agentId: "agent-fixture",
      repositoryName: "fixture",
      directory: fixture.mount,
      remoteUrl: fixture.source,
      token: "",
    },
    {
      git: async (cwd, args) => {
        if (failHeadProbe && args[0] === "rev-parse") {
          throw new Error("Git probe failed");
        }
        return { stdout: git(cwd, args, ignorecase) };
      },
      gitWithRetry: async (cwd, args) => ({
        stdout: git(cwd, args, ignorecase),
      }),
      prepare: async () => {},
      installHook: () => {},
      cloneTimeoutMs: 10_000,
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("case-colliding tracked paths", () => {
  test("detects both directory and file aliases, but not consistent spelling", () => {
    expect(findCaseCollidingTrackedPath(["PDF/a.md", "pdf/b.md"])).toBe(true);
    expect(findCaseCollidingTrackedPath(["Notes/A.md", "Notes/a.md"])).toBe(
      true,
    );
    expect(findCaseCollidingTrackedPath(["Notes/A.md", "Notes/B.md"])).toBe(
      false,
    );
  });

  test("rejects a fresh colliding mount before publishing a checkout", async () => {
    const fixture = makeFixture();
    addCaseVariants(fixture.source);

    await expect(syncFixture(fixture)).rejects.toThrow(
      "tracks paths that differ only by case",
    );
    expect(existsSync(fixture.mount)).toBe(false);
  });

  test("does not publish a mount when the HEAD probe fails", async () => {
    const fixture = makeFixture();
    await expect(syncFixture(fixture, true, true)).rejects.toThrow(
      "Git probe failed",
    );
    expect(existsSync(fixture.mount)).toBe(false);
  });

  test("rejects a new collision before advancing an existing mount", async () => {
    const fixture = makeFixture();
    await syncFixture(fixture);
    const originalHead = git(fixture.mount, ["rev-parse", "HEAD"]).trim();
    addCaseVariants(fixture.source);

    await expect(syncFixture(fixture)).rejects.toThrow(
      "tracks paths that differ only by case",
    );
    expect(git(fixture.mount, ["rev-parse", "HEAD"]).trim()).toBe(originalHead);
  });

  test("diagnoses an already-mounted colliding checkout without changing it", async () => {
    const fixture = makeFixture();
    addCaseVariants(fixture.source);
    git(fixture.root, ["clone", fixture.source, fixture.mount], false);
    const originalHead = git(fixture.mount, ["rev-parse", "HEAD"]).trim();

    await expect(syncFixture(fixture)).rejects.toThrow(
      "tracks paths that differ only by case",
    );
    expect(git(fixture.mount, ["rev-parse", "HEAD"]).trim()).toBe(originalHead);
  });

  test("fast-forwards an existing mount without a collision", async () => {
    const fixture = makeFixture();
    await syncFixture(fixture);
    expect(existsSync(join(fixture.mount, "MEMORY.md"))).toBe(true);
    writeFileSync(join(fixture.source, "note.md"), "# Safe\n");
    git(fixture.source, ["add", "note.md"]);
    git(fixture.source, ["commit", "-qm", "safe update"]);

    await syncFixture(fixture);
    expect(existsSync(join(fixture.mount, "note.md"))).toBe(true);
    expect(git(fixture.mount, ["status", "--porcelain"])).toBe("");
  });

  test("preserves local commits when the remote has not advanced", async () => {
    const fixture = makeFixture();
    await syncFixture(fixture);
    writeFileSync(join(fixture.mount, "local.md"), "# Local\n");
    git(fixture.mount, ["add", "local.md"]);
    git(fixture.mount, ["commit", "-qm", "local change"]);
    const localHead = git(fixture.mount, ["rev-parse", "HEAD"]).trim();

    await syncFixture(fixture);
    expect(git(fixture.mount, ["rev-parse", "HEAD"]).trim()).toBe(localHead);
    expect(existsSync(join(fixture.mount, "local.md"))).toBe(true);
  });

  test.skipIf(process.platform !== "linux")(
    "keeps a normal checkout possible on a case-sensitive filesystem",
    async () => {
      const fixture = makeFixture();
      addCaseVariants(fixture.source);

      await syncFixture(fixture, false);
      expect(git(fixture.mount, ["ls-files"], false)).toContain("PDF/one.md");
      expect(git(fixture.mount, ["ls-files"], false)).toContain("pdf/two.md");
    },
  );

  test.skipIf(process.platform !== "win32")(
    "rejects a case collision on Windows even when Git ignorecase is false",
    async () => {
      const fixture = makeFixture();
      addCaseVariants(fixture.source);

      await expect(syncFixture(fixture, false)).rejects.toThrow(
        "tracks paths that differ only by case",
      );
      expect(existsSync(fixture.mount)).toBe(false);
    },
  );

  test("mounts an empty repository and later receives its first commit", async () => {
    const fixture = makeEmptyFixture();
    await syncFixture(fixture);
    expect(existsSync(join(fixture.mount, ".git"))).toBe(true);

    writeFileSync(join(fixture.source, "MEMORY.md"), "# New repo\n");
    git(fixture.source, ["add", "MEMORY.md"]);
    git(fixture.source, ["commit", "-qm", "first commit"]);
    await syncFixture(fixture);
    expect(existsSync(join(fixture.mount, "MEMORY.md"))).toBe(true);
  });
});
