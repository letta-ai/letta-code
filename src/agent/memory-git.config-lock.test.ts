import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalGitConfig, setLocalGitConfig } from "@/agent/memory-git";
import { isGitConfigLockError } from "@/agent/memory-git-config-lock";

describe("isGitConfigLockError", () => {
  test("returns true for the 'could not lock config file' spelling", () => {
    expect(
      isGitConfigLockError(
        new Error(
          "Command failed: git config --local user.email a@letta.com\nerror: could not lock config file .git/config: File exists\n",
        ),
      ),
    ).toBe(true);
  });

  test("returns true for the 'Unable to create ... config.lock' spelling", () => {
    expect(
      isGitConfigLockError(
        new Error(
          "fatal: Unable to create '/tmp/repo/.git/config.lock': File exists",
        ),
      ),
    ).toBe(true);
  });

  test("returns false for unrelated git failures", () => {
    expect(isGitConfigLockError(new Error("fatal: not a git repository"))).toBe(
      false,
    );
    // A lock on a *different* file is a different failure with a different fix.
    expect(
      isGitConfigLockError(
        new Error("fatal: Unable to create '/tmp/repo/.git/index.lock'"),
      ),
    ).toBe(false);
    expect(isGitConfigLockError(undefined)).toBe(false);
  });
});

describe("concurrent local git config mutations", () => {
  // Regression test: memory-repo bootstrap has several independent config
  // writers (identity reconciliation, git-ops preparation, credential helper).
  // `git config` takes an exclusive .git/config.lock and fails instead of
  // waiting, so unserialized writes lost the race ~80% of the time and failed
  // agent creation with "could not lock config file .git/config: File exists".
  test("all writes land when issued concurrently against one repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-config-lock-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });

      const keys = Array.from({ length: 12 }, (_, i) => `letta.probe${i}`);
      await Promise.all(
        keys.map((key, i) => setLocalGitConfig(dir, key, `value-${i}`)),
      );

      for (const [i, key] of keys.entries()) {
        expect(await getLocalGitConfig(dir, key)).toBe(`value-${i}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing write does not cancel writes queued behind it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-config-lock-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });

      // An invalid key name is rejected by git itself, not by lock contention.
      const results = await Promise.allSettled([
        setLocalGitConfig(dir, "not-a-section", "x"),
        setLocalGitConfig(dir, "letta.after", "survived"),
      ]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      expect(await getLocalGitConfig(dir, "letta.after")).toBe("survived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
