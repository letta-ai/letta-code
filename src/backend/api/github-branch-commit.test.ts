import { describe, expect, test } from "bun:test";
import {
  type RunCommand,
  resolveGithubBranchCommit,
  resolveSandboxRepositoryBranches,
} from "./github-branch-commit";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function failure(message: string, exitCode: number | null): Error {
  // Mirrors the runner's error: an Error carrying the process exit code.
  return Object.assign(new Error(message), { exitCode });
}

describe("resolveGithubBranchCommit", () => {
  test("reads the branch tip from git ls-remote without a shell or prompt", async () => {
    const calls: Array<{ command: string; args: string[]; prompt?: string }> =
      [];
    const run: RunCommand = async (command, args, options) => {
      calls.push({ command, args, prompt: options.env.GIT_TERMINAL_PROMPT });
      return `${SHA.toUpperCase()}\trefs/heads/feature/wip\n`;
    };
    expect(
      await resolveGithubBranchCommit(
        { owner: "owner", repo: "repo", branch: "feature/wip" },
        run,
      ),
    ).toBe(SHA);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "ls-remote",
          "--exit-code",
          "https://github.com/owner/repo.git",
          "refs/heads/feature/wip",
        ],
        prompt: "0",
      },
    ]);
  });

  test("ignores other refs that match the pattern's suffix", async () => {
    const run: RunCommand = async () =>
      `${"f".repeat(40)}\trefs/heads/other/main\n${SHA}\trefs/heads/main\n`;
    expect(
      await resolveGithubBranchCommit(
        { owner: "owner", repo: "repo", branch: "main" },
        run,
      ),
    ).toBe(SHA);
  });

  test("reports a missing branch when git reaches the repo", async () => {
    const run: RunCommand = async () => {
      throw failure("", 2);
    };
    await expect(
      resolveGithubBranchCommit(
        { owner: "owner", repo: "repo", branch: "gone" },
        run,
      ),
    ).rejects.toThrow('Branch "gone" not found in owner/repo.');
  });

  test("falls back to the GitHub CLI when git cannot read the repo", async () => {
    const commands: string[] = [];
    const run: RunCommand = async (command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      if (command === "git")
        throw failure("fatal: could not read Username", 128);
      return `${SHA}\n`;
    };
    expect(
      await resolveGithubBranchCommit(
        { owner: "owner", repo: "private", branch: "feature/wip" },
        run,
      ),
    ).toBe(SHA);
    expect(commands[1]).toBe(
      "gh api repos/owner/private/commits/feature%2Fwip -H Accept: application/vnd.github.sha",
    );
  });

  test("explains how to fix access when neither git nor gh can resolve", async () => {
    const run: RunCommand = async (command) => {
      throw failure(
        command === "git" ? "fatal: repository not found" : "gh: not found",
        command === "git" ? 128 : 1,
      );
    };
    await expect(
      resolveGithubBranchCommit(
        { owner: "owner", repo: "repo", branch: "main" },
        run,
      ),
    ).rejects.toThrow(
      "Couldn't resolve owner/repo@main to a commit: fatal: repository not found.",
    );
  });
});

describe("resolveSandboxRepositoryBranches", () => {
  test("pins branches to commits and passes other entries through", async () => {
    const asked: string[] = [];
    const resolved = await resolveSandboxRepositoryBranches(
      [
        { owner: "owner", repo: "app", branch: "wip" },
        { owner: "owner", repo: "lib" },
        { owner: "owner", repo: "pinned", commit: SHA },
      ],
      async ({ owner, repo, branch }) => {
        asked.push(`${owner}/${repo}@${branch}`);
        return SHA;
      },
    );
    expect(asked).toEqual(["owner/app@wip"]);
    expect(resolved).toEqual([
      { owner: "owner", repo: "app", commit: SHA },
      { owner: "owner", repo: "lib" },
      { owner: "owner", repo: "pinned", commit: SHA },
    ]);
  });
});
