import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryCloneArgs,
  getMemoryMergeBaseStatusAfterDeepening,
  isShallowMemoryRepo,
  MEMORY_CLONE_DEPTH_ENV,
  resolveMemoryCloneDepth,
} from "./memory-git-shallow";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function runGit(cwd: string, args: string[]) {
  return { stdout: git(cwd, args), stderr: "" };
}

function configureIdentity(repo: string): void {
  git(repo, ["config", "user.name", "Memfs Shallow Test"]);
  git(repo, ["config", "user.email", "memfs-shallow-test@letta.com"]);
}

function commitFile(repo: string, path: string, content: string): string {
  writeFileSync(join(repo, path), content, "utf8");
  git(repo, ["add", path]);
  git(repo, ["commit", "-m", `update ${path}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A memory remote with five commits of history, plus a seed checkout. */
function makeMemoryRemote(): { root: string; remote: string; seed: string } {
  const root = mkdtempSync(join(tmpdir(), "memfs-shallow-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");

  git(root, ["init", "--bare", remote]);
  git(root, ["init", "--initial-branch=main", seed]);
  configureIdentity(seed);
  for (let i = 0; i < 5; i += 1) {
    commitFile(seed, `note-${i}.md`, `revision ${i}\n`);
  }
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote, seed };
}

/** Clone exactly the way cloneMemoryRepo does, for the given runtime env. */
function cloneMemory(
  fixture: ReturnType<typeof makeMemoryRemote>,
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  const dir = join(fixture.root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, buildMemoryCloneArgs(`file://${fixture.remote}`, env));
  configureIdentity(dir);
  return dir;
}

const SLACK_V2_ENV: NodeJS.ProcessEnv = { [MEMORY_CLONE_DEPTH_ENV]: "1" };
const DEFAULT_ENV: NodeJS.ProcessEnv = {};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMemoryCloneDepth", () => {
  test("reads a positive depth from the runtime environment", () => {
    expect(resolveMemoryCloneDepth({ [MEMORY_CLONE_DEPTH_ENV]: "1" })).toBe(1);
    expect(resolveMemoryCloneDepth({ [MEMORY_CLONE_DEPTH_ENV]: " 5 " })).toBe(
      5,
    );
  });

  test("falls back to a full clone when unset or malformed", () => {
    for (const value of [undefined, "", "0", "-1", "1.5", "deep"]) {
      expect(
        resolveMemoryCloneDepth(
          value === undefined ? {} : { [MEMORY_CLONE_DEPTH_ENV]: value },
        ),
      ).toBeUndefined();
    }
  });
});

describe("memory clone depth", () => {
  test("a Slack v2 runtime clones only the latest commit", () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "slack-v2", SLACK_V2_ENV);

    expect(git(dir, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(dir, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(
      git(fixture.seed, ["rev-parse", "HEAD"]),
    );
  });

  test("a runtime without the setting clones the full history", () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "default", DEFAULT_ENV);

    expect(git(dir, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(git(dir, ["rev-list", "--count", "HEAD"])).toBe("5");
    expect(
      buildMemoryCloneArgs("https://memfs.example/repo", DEFAULT_ENV),
    ).toEqual(["clone", "https://memfs.example/repo", "."]);
  });

  test("cloneMemoryRepo routes both clone sites through buildMemoryCloneArgs", () => {
    const source = readFileSync(
      new URL("./memory-git.ts", import.meta.url),
      "utf8",
    );
    const cloneFn = source.slice(
      source.indexOf("export async function cloneMemoryRepo("),
      source.indexOf("export interface PullMemoryOptions "),
    );
    expect(cloneFn).toContain("buildMemoryCloneArgs(url)");
    expect(cloneFn).not.toContain('["clone", url, "."]');
  });
});

describe("git operations on a shallow memory checkout", () => {
  test("fast-forward pull and push still work", () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "slack-v2", SLACK_V2_ENV);

    // Remote advances by two commits while the shallow checkout is idle.
    commitFile(fixture.seed, "note-5.md", "revision 5\n");
    const remoteHead = commitFile(fixture.seed, "note-6.md", "revision 6\n");
    git(fixture.seed, ["push", "origin", "main"]);

    git(dir, ["pull", "--ff-only"]);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(git(dir, ["rev-parse", "--is-shallow-repository"])).toBe("true");

    const localSha = commitFile(dir, "agent-note.md", "written by the agent\n");
    git(dir, ["push", "origin", "main"]);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(localSha);
  });

  test("rebases a local commit over a diverged remote on a single-commit base", () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "slack-v2", SLACK_V2_ENV);

    const localSha = commitFile(dir, "agent-note.md", "written by the agent\n");
    const remoteSha = commitFile(fixture.seed, "note-5.md", "revision 5\n");
    git(fixture.seed, ["push", "origin", "main"]);

    // The ff-only pull memory sync tries first cannot succeed here.
    expect(() => git(dir, ["pull", "--ff-only"])).toThrow();

    git(dir, ["pull", "--rebase"]);
    const log = git(dir, ["log", "--format=%s"]).split("\n");
    expect(log[0]).toBe("update agent-note.md");
    expect(log[1]).toBe("update note-5.md");
    expect(git(dir, ["rev-parse", "HEAD"])).not.toBe(localSha);
    expect(git(dir, ["rev-parse", "HEAD~1"])).toBe(remoteSha);

    git(dir, ["push", "origin", "main"]);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(
      git(dir, ["rev-parse", "HEAD"]),
    );
  });
});

describe("getMemoryMergeBaseStatusAfterDeepening", () => {
  test("reports the merge base a shallow checkout can already see", async () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "slack-v2", SLACK_V2_ENV);
    commitFile(dir, "agent-note.md", "written by the agent\n");
    commitFile(fixture.seed, "note-5.md", "revision 5\n");
    git(fixture.seed, ["push", "origin", "main"]);
    git(dir, ["fetch", "origin", "main"]);

    expect(await getMemoryMergeBaseStatusAfterDeepening(dir, runGit)).toBe(
      "connected",
    );
    // Nothing was missing, so the checkout stays shallow.
    expect(await isShallowMemoryRepo(dir, runGit)).toBe(true);
  });

  test("unshallows before declaring histories unrelated after a remote rewrite", async () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "slack-v2", SLACK_V2_ENV);
    commitFile(dir, "agent-note.md", "written by the agent\n");

    // The remote rewrites the commit the shallow clone was grafted at, so the
    // fork point now sits below the checkout's boundary.
    git(fixture.seed, ["commit", "--amend", "-m", "rewritten history"]);
    git(fixture.seed, ["push", "--force", "origin", "main"]);
    git(dir, ["fetch", "origin", "main"]);

    expect(await getMemoryMergeBaseStatusAfterDeepening(dir, runGit)).toBe(
      "connected",
    );
    expect(await isShallowMemoryRepo(dir, runGit)).toBe(false);
    // Having recovered the history, the diverged pull rebases instead of
    // falling through to a reset-to-remote.
    git(dir, ["pull", "--rebase"]);
    expect(git(dir, ["log", "--format=%s"]).split("\n")[0]).toBe(
      "update agent-note.md",
    );
  });

  test("keeps a failed unshallow inconclusive instead of authorizing reset", async () => {
    const calls: string[] = [];
    const status = await getMemoryMergeBaseStatusAfterDeepening(
      "/unused",
      async (_cwd, args) => {
        calls.push(args.join(" "));
        if (args[0] === "merge-base") {
          throw Object.assign(new Error("no merge base"), { code: 1 });
        }
        if (args[0] === "rev-parse") {
          return { stdout: "true", stderr: "" };
        }
        throw new Error("fetch timed out");
      },
    );

    expect(status).toBe("indeterminate");
    expect(calls).toEqual([
      "merge-base HEAD @{u}",
      "rev-parse --is-shallow-repository",
      "fetch --unshallow origin",
      "rev-parse --is-shallow-repository",
    ]);
  });

  test("handles another pull winning the unshallow race", async () => {
    let mergeBaseChecks = 0;
    let shallowChecks = 0;
    const status = await getMemoryMergeBaseStatusAfterDeepening(
      "/unused",
      async (_cwd, args) => {
        if (args[0] === "merge-base") {
          mergeBaseChecks += 1;
          if (mergeBaseChecks === 1) {
            throw Object.assign(new Error("no merge base"), { code: 1 });
          }
          return { stdout: "base\n", stderr: "" };
        }
        if (args[0] === "rev-parse") {
          shallowChecks += 1;
          return {
            stdout: shallowChecks === 1 ? "true" : "false",
            stderr: "",
          };
        }
        throw new Error("repository is already complete");
      },
    );

    expect(status).toBe("connected");
  });

  test("keeps merge-base execution failures inconclusive", async () => {
    const status = await getMemoryMergeBaseStatusAfterDeepening(
      "/unused",
      async () => {
        throw Object.assign(new Error("upstream unavailable"), { code: 128 });
      },
    );

    expect(status).toBe("indeterminate");
  });

  test("reports no merge base for genuinely unrelated full clones", async () => {
    const fixture = makeMemoryRemote();
    const dir = cloneMemory(fixture, "default", DEFAULT_ENV);
    git(dir, ["checkout", "--orphan", "rewritten"]);
    commitFile(dir, "orphan.md", "unrelated history\n");
    git(dir, ["branch", "-M", "main"]);
    git(dir, ["branch", "--set-upstream-to", "origin/main", "main"]);

    expect(await getMemoryMergeBaseStatusAfterDeepening(dir, runGit)).toBe(
      "unrelated",
    );
  });
});
