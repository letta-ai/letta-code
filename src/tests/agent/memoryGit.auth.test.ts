import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatGitCredentialHelperPath,
  getGitRemoteUrl,
  isMemfsRemoteUrlForAgent,
  maybeUpdateMemoryRemoteOrigin,
  normalizeCredentialBaseUrl,
} from "../../agent/memoryGit";

const ORIGINAL_LETTA_BASE_URL = process.env.LETTA_BASE_URL;

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];

  if (ORIGINAL_LETTA_BASE_URL === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = ORIGINAL_LETTA_BASE_URL;
  }
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-git-auth-"));
  tempDirs.push(dir);
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  return dir;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrEmpty(cwd: string, args: string): string {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

describe("normalizeCredentialBaseUrl", () => {
  test("normalizes Letta Cloud URL to origin", () => {
    expect(normalizeCredentialBaseUrl("https://api.letta.com")).toBe(
      "https://api.letta.com",
    );
  });

  describe("getGitRemoteUrl", () => {
    test("builds remote URL from provided base URL", () => {
      expect(getGitRemoteUrl("agent-123", "http://localhost:51338/")).toBe(
        "http://localhost:51338/v1/git/agent-123/state.git",
      );
    });
  });

  describe("isMemfsRemoteUrlForAgent", () => {
    test("returns true for this agent's memfs HTTP URL", () => {
      expect(
        isMemfsRemoteUrlForAgent(
          "http://localhost:51338/v1/git/agent-123/state.git/",
          "agent-123",
        ),
      ).toBe(true);
    });

    test("returns false for different agent ID", () => {
      expect(
        isMemfsRemoteUrlForAgent(
          "http://localhost:51338/v1/git/agent-999/state.git",
          "agent-123",
        ),
      ).toBe(false);
    });

    test("returns false for non-memfs remotes", () => {
      expect(isMemfsRemoteUrlForAgent("/tmp/remote.git", "agent-123")).toBe(
        false,
      );
    });
  });

  test("strips trailing slashes", () => {
    expect(normalizeCredentialBaseUrl("https://api.letta.com///")).toBe(
      "https://api.letta.com",
    );
  });

  test("drops path/query/fragment and keeps origin", () => {
    expect(
      normalizeCredentialBaseUrl(
        "https://api.letta.com/custom/path?foo=bar#fragment",
      ),
    ).toBe("https://api.letta.com");
  });

  test("preserves explicit port", () => {
    expect(normalizeCredentialBaseUrl("http://localhost:8283/v1/")).toBe(
      "http://localhost:8283",
    );
  });

  test("falls back to trimmed value when URL parsing fails", () => {
    expect(normalizeCredentialBaseUrl("not-a-valid-url///")).toBe(
      "not-a-valid-url",
    );
  });
});

describe("formatGitCredentialHelperPath", () => {
  test("normalizes slashes and escapes whitespace for helper command parsing", () => {
    expect(
      formatGitCredentialHelperPath(
        String.raw`C:\Users\Jane Doe\.letta\agents\agent-1\memory\.git\letta-credential-helper.cmd`,
      ),
    ).toBe(
      "C:/Users/Jane\\ Doe/.letta/agents/agent-1/memory/.git/letta-credential-helper.cmd",
    );
  });
});

describe("maybeUpdateMemoryRemoteOrigin", () => {
  test("updates stale memfs origin URL and clears stale origin pushurl", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const staleOrigin = getGitRemoteUrl(agentId, "http://localhost:50864");
    const expectedOrigin = getGitRemoteUrl(agentId, "https://api.letta.com");

    process.env.LETTA_BASE_URL = "https://api.letta.com";
    git(repo, `remote add origin ${staleOrigin}`);
    git(repo, `config --local remote.origin.pushurl ${staleOrigin}`);

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(expectedOrigin);
    expect(
      gitOrEmpty(repo, "config --local --get-all remote.origin.pushurl"),
    ).toBe("");
  });

  test("clears origin pushurl even when origin URL is already current", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const expectedOrigin = getGitRemoteUrl(agentId, "https://api.letta.com");
    const stalePushUrl = getGitRemoteUrl(agentId, "http://localhost:50864");

    process.env.LETTA_BASE_URL = "https://api.letta.com";
    git(repo, `remote add origin ${expectedOrigin}`);
    git(repo, `config --local remote.origin.pushurl ${stalePushUrl}`);

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(expectedOrigin);
    expect(
      gitOrEmpty(repo, "config --local --get-all remote.origin.pushurl"),
    ).toBe("");
  });

  test("clears non-memfs pushurl when origin is this agent's memfs remote", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const expectedOrigin = getGitRemoteUrl(agentId, "https://api.letta.com");

    process.env.LETTA_BASE_URL = "https://api.letta.com";
    git(repo, `remote add origin ${expectedOrigin}`);
    git(
      repo,
      "config --local remote.origin.pushurl git@github.com:example/not-origin.git",
    );

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(expectedOrigin);
    expect(
      gitOrEmpty(repo, "config --local --get-all remote.origin.pushurl"),
    ).toBe("");
  });

  test("leaves non-memfs origins and pushurls untouched", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const origin = "git@github.com:example/memory.git";
    const pushUrl = "git@github.com:example/memory-push.git";

    process.env.LETTA_BASE_URL = "https://api.letta.com";
    git(repo, `remote add origin ${origin}`);
    git(repo, `config --local remote.origin.pushurl ${pushUrl}`);

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(origin);
    expect(
      git(repo, "config --local --get-all remote.origin.pushurl").trim(),
    ).toBe(pushUrl);
  });
});
