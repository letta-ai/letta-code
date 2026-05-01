import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMemoryRepoReadyForWrite,
  buildGitAuthArgs,
  buildMemfsGitProxyArgs,
  buildNonInteractiveGitEnv,
  formatGitCredentialHelperPath,
  getGitRemoteUrl,
  isMemfsRemoteUrlForAgent,
  maybeUpdateMemoryRemoteOrigin,
  normalizeCredentialBaseUrl,
  shouldConfigurePersistentMemfsCredentialHelper,
} from "../../agent/memoryGit";
import {
  __testOverrideGetClient,
  getMemfsServerUrl,
} from "../../backend/api/client";

const ORIGINAL_LETTA_BASE_URL = process.env.LETTA_BASE_URL;
const ORIGINAL_LETTA_MEMFS_BASE_URL = process.env.LETTA_MEMFS_BASE_URL;
const ORIGINAL_LETTA_DESKTOP_DEBUG_PANEL =
  process.env.LETTA_DESKTOP_DEBUG_PANEL;
const ORIGINAL_LETTA_MEMFS_GIT_PROXY_BASE_URL =
  process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL;
const ORIGINAL_LETTA_API_KEY = process.env.LETTA_API_KEY;

let tempDirs: string[] = [];

afterEach(() => {
  __testOverrideGetClient(null);

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];

  if (ORIGINAL_LETTA_BASE_URL === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = ORIGINAL_LETTA_BASE_URL;
  }

  if (ORIGINAL_LETTA_MEMFS_BASE_URL === undefined) {
    delete process.env.LETTA_MEMFS_BASE_URL;
  } else {
    process.env.LETTA_MEMFS_BASE_URL = ORIGINAL_LETTA_MEMFS_BASE_URL;
  }

  if (ORIGINAL_LETTA_DESKTOP_DEBUG_PANEL === undefined) {
    delete process.env.LETTA_DESKTOP_DEBUG_PANEL;
  } else {
    process.env.LETTA_DESKTOP_DEBUG_PANEL = ORIGINAL_LETTA_DESKTOP_DEBUG_PANEL;
  }

  if (ORIGINAL_LETTA_MEMFS_GIT_PROXY_BASE_URL === undefined) {
    delete process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL;
  } else {
    process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL =
      ORIGINAL_LETTA_MEMFS_GIT_PROXY_BASE_URL;
  }

  if (ORIGINAL_LETTA_API_KEY === undefined) {
    delete process.env.LETTA_API_KEY;
  } else {
    process.env.LETTA_API_KEY = ORIGINAL_LETTA_API_KEY;
  }
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-git-auth-"));
  tempDirs.push(dir);
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeBareGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-git-remote-"));
  tempDirs.push(dir);
  execSync("git init --bare -b main", { cwd: dir, stdio: "ignore" });
  return dir;
}

function commitFile(repo: string, fileName: string, content: string): string {
  writeFileSync(join(repo, fileName), content, "utf-8");
  git(repo, `add ${fileName}`);
  git(repo, `commit -m ${fileName}`);
  return git(repo, "rev-parse HEAD").trim();
}

function makeSyncedRepo(): { repo: string; remote: string } {
  const remote = makeBareGitRepo();
  const repo = makeGitRepo();
  git(repo, "config user.name Test");
  git(repo, "config user.email test@example.com");
  git(repo, `remote add origin ${remote}`);
  commitFile(repo, "initial.md", "initial");
  git(repo, "push -u origin main");
  return { repo, remote };
}

function cloneRepo(remote: string): string {
  const repo = mkdtempSync(join(tmpdir(), "memory-git-clone-"));
  tempDirs.push(repo);
  execSync(`git clone ${remote} .`, { cwd: repo, stdio: "ignore" });
  git(repo, "config user.name Test");
  git(repo, "config user.email test@example.com");
  return repo;
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

    test("prefers LETTA_MEMFS_BASE_URL over LETTA_BASE_URL when base URL is omitted", () => {
      process.env.LETTA_BASE_URL = "http://localhost:51338";
      process.env.LETTA_MEMFS_BASE_URL = "https://selfhost.example.com";
      expect(getGitRemoteUrl("agent-123")).toBe(
        "https://selfhost.example.com/v1/git/agent-123/state.git",
      );
    });

    test("defaults to api.letta.com when LETTA_MEMFS_BASE_URL is unset, even if LETTA_BASE_URL is localhost", () => {
      process.env.LETTA_BASE_URL = "http://localhost:51338";
      delete process.env.LETTA_MEMFS_BASE_URL;
      delete process.env.LETTA_DESKTOP_DEBUG_PANEL;
      expect(getGitRemoteUrl("agent-123")).toBe(
        "https://api.letta.com/v1/git/agent-123/state.git",
      );
    });

    test("keeps canonical memfs URL stable in desktop proxy transport sessions", () => {
      process.env.LETTA_BASE_URL = "http://localhost:51338";
      delete process.env.LETTA_MEMFS_BASE_URL;
      process.env.LETTA_DESKTOP_DEBUG_PANEL = "1";
      process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:51338";

      expect(getMemfsServerUrl()).toBe("https://api.letta.com");
      expect(getGitRemoteUrl("agent-123")).toBe(
        "https://api.letta.com/v1/git/agent-123/state.git",
      );
    });

    test("uses desktop proxy as a transient git transport rewrite for network commands", () => {
      process.env.LETTA_BASE_URL = "http://localhost:51338";
      delete process.env.LETTA_MEMFS_BASE_URL;
      process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:51338";

      expect(buildMemfsGitProxyArgs(["push"])).toEqual([
        "-c",
        "url.http://localhost:51338/v1/git/.insteadOf=https://api.letta.com/v1/git/",
      ]);
      expect(buildMemfsGitProxyArgs(["pull", "--ff-only"])).toEqual([
        "-c",
        "url.http://localhost:51338/v1/git/.insteadOf=https://api.letta.com/v1/git/",
      ]);
    });

    test("does not apply desktop proxy rewrite to local git config reads", () => {
      delete process.env.LETTA_MEMFS_BASE_URL;
      process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:51338";

      expect(buildMemfsGitProxyArgs(["remote", "get-url", "origin"])).toEqual(
        [],
      );
      expect(buildMemfsGitProxyArgs(["config", "--local", "--list"])).toEqual(
        [],
      );
      expect(buildMemfsGitProxyArgs(["status", "--porcelain"])).toEqual([]);
    });

    test("does not proxy explicit self-hosted memfs URLs", () => {
      process.env.LETTA_MEMFS_BASE_URL = "https://selfhost.example.com";
      process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:51338";

      expect(buildMemfsGitProxyArgs(["push"])).toEqual([]);
      expect(getGitRemoteUrl("agent-123")).toBe(
        "https://selfhost.example.com/v1/git/agent-123/state.git",
      );
    });

    test("does not persist credential helpers when desktop proxy transport is active", () => {
      delete process.env.LETTA_MEMFS_BASE_URL;
      process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:51338";

      expect(shouldConfigurePersistentMemfsCredentialHelper()).toBe(false);
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

describe("git auth hardening", () => {
  test("auth args pass Basic auth and suppress inherited credential helpers", () => {
    const args = buildGitAuthArgs("token-123");

    expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(args).toContain("core.askPass=");
    expect(args.join("\n")).toContain("http.extraHeader=Authorization: Basic");
  });

  test("git env disables terminal and Git Credential Manager prompts", () => {
    const env = buildNonInteractiveGitEnv({ PATH: "/usr/bin" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS).toBe("");
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

  test("repairs stale desktop proxy origin back to canonical cloud while proxy transport is active", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const staleOrigin = getGitRemoteUrl(agentId, "http://localhost:50864");

    process.env.LETTA_BASE_URL = "http://localhost:54085";
    process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = "http://localhost:54085";
    delete process.env.LETTA_MEMFS_BASE_URL;
    git(repo, `remote add origin ${staleOrigin}`);

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(
      "https://api.letta.com/v1/git/agent-123/state.git",
    );
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

  test("updates stale memfs origin to LETTA_MEMFS_BASE_URL when proxy LETTA_BASE_URL differs", async () => {
    const repo = makeGitRepo();
    const agentId = "agent-123";
    const staleOrigin = getGitRemoteUrl(agentId, "http://localhost:50864");
    const expectedOrigin = getGitRemoteUrl(
      agentId,
      "https://selfhost.example.com",
    );

    process.env.LETTA_BASE_URL = "http://localhost:54085";
    process.env.LETTA_MEMFS_BASE_URL = "https://selfhost.example.com";
    git(repo, `remote add origin ${staleOrigin}`);
    git(repo, `config --local remote.origin.pushurl ${staleOrigin}`);

    await maybeUpdateMemoryRemoteOrigin(repo, agentId);

    expect(git(repo, "remote get-url origin").trim()).toBe(expectedOrigin);
    expect(
      gitOrEmpty(repo, "config --local --get-all remote.origin.pushurl"),
    ).toBe("");
  });
});

describe("assertMemoryRepoReadyForWrite", () => {
  test("pushes clean local commits before blocking memory writes", async () => {
    const { repo, remote } = makeSyncedRepo();
    const localSha = commitFile(repo, "local.md", "local");
    process.env.LETTA_API_KEY = "test-token";
    __testOverrideGetClient(async () => ({
      _options: { apiKey: "test-token" },
    }));

    await assertMemoryRepoReadyForWrite(repo, "agent-123");

    expect(git(repo, "rev-list --count @{u}..HEAD").trim()).toBe("0");
    expect(
      execSync(`git --git-dir ${remote} rev-parse main`, {
        encoding: "utf-8",
      }).trim(),
    ).toBe(localSha);
  });

  test("leaves clean behind repos for write-time conflict replay", async () => {
    const { repo, remote } = makeSyncedRepo();
    const originalSha = git(repo, "rev-parse HEAD").trim();
    const other = cloneRepo(remote);
    commitFile(other, "remote.md", "remote");
    git(other, "push");
    process.env.LETTA_API_KEY = "test-token";
    __testOverrideGetClient(async () => ({
      _options: { apiKey: "test-token" },
    }));

    await assertMemoryRepoReadyForWrite(repo, "agent-123");

    expect(git(repo, "rev-parse HEAD").trim()).toBe(originalSha);
  });
});
