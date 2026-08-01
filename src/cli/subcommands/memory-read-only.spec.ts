import { describe, expect, it } from "bun:\u0074est";
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
import { PRE_COMMIT_HOOK_SCRIPT } from "@/agent/memory-git-hooks";
import { checkPermission } from "@/permissions/checker";
import type { PermissionRules } from "@/permissions/types";
import {
  runMemoryReadOnlyAction,
  updateReadOnlyFrontmatter,
} from "./memory-read-only";

const EMPTY_PERMISSIONS: PermissionRules = {
  allow: [],
  deny: [],
  ask: [],
  alwaysAsk: [],
  additionalDirectories: [],
};

describe("read-only memory frontmatter", () => {
  it("adds and toggles read_only without rewriting other content", () => {
    const original =
      "---\ndescription: Keep this exactly\nlimit: legacy\n---\n\nBody\n";
    const enabled = updateReadOnlyFrontmatter(original, true);
    expect(enabled.previous).toBeNull();
    expect(enabled.content).toBe(
      "---\ndescription: Keep this exactly\nlimit: legacy\nread_only: true\n---\n\nBody\n",
    );

    const disabled = updateReadOnlyFrontmatter(enabled.content, false);
    expect(disabled.previous).toBe(true);
    expect(disabled.content).toContain("read_only: false");
    expect(updateReadOnlyFrontmatter(disabled.content, false).changed).toBe(
      false,
    );
  });

  it("preserves CRLF line endings", () => {
    const result = updateReadOnlyFrontmatter(
      "---\r\ndescription: Windows\r\n---\r\nBody\r\n",
      true,
    );
    expect(result.content).toBe(
      "---\r\ndescription: Windows\r\nread_only: true\r\n---\r\nBody\r\n",
    );
  });
});

describe("read-only memory approval", () => {
  it("always asks even when the permission mode is unrestricted", () => {
    const result = checkPermission(
      "Bash",
      { command: "letta memory read-only system/persona.md true" },
      EMPTY_PERMISSIONS,
    );
    expect(result.decision).toBe("alwaysAsk");
    expect(result.reason).toContain("explicit user approval");
  });

  it("recognizes toggles after a chained command", () => {
    const result = checkPermission(
      "exec_command",
      { cmd: "cd /tmp && letta memfs read-only system/persona.md false" },
      EMPTY_PERMISSIONS,
    );
    expect(result.decision).toBe("alwaysAsk");
  });

  it("recognizes an absolute letta executable path", () => {
    const result = checkPermission(
      "Bash",
      {
        command:
          "/usr/local/bin/letta memory read-only reference/policy.md true",
      },
      EMPTY_PERMISSIONS,
    );
    expect(result.decision).toBe("alwaysAsk");
  });

  it("recognizes shell-wrapped toggles", () => {
    for (const command of [
      `sh -c "letta memory read-only system/persona.md true"`,
      `bash -c 'letta.js memfs read-only reference/policy.md false'`,
    ]) {
      expect(
        checkPermission("Bash", { command }, EMPTY_PERMISSIONS).decision,
      ).toBe("alwaysAsk");
    }
  });
});

describe("read-only memory commits", () => {
  it("blocks deletion and rename while allowing the approved CLI toggle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-read-only-"));
    const git = (args: string[], env?: NodeJS.ProcessEnv) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.com",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.com",
          ...env,
        },
        encoding: "utf8",
        stdio: "pipe",
      });

    try {
      git(["init"]);
      mkdirSync(join(dir, "system"), { recursive: true });
      const file = join(dir, "system", "locked.md");
      writeFileSync(
        file,
        "---\ndescription: Locked\nread_only: true\n---\n\nBody\n",
      );
      git(["add", "system/locked.md"]);
      git(["commit", "-m", "fixture"]);

      const hook = join(dir, ".git", "hooks", "pre-commit");
      writeFileSync(hook, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
      git(["rm", "system/locked.md"]);
      expect(() => git(["commit", "-m", "delete"])).toThrow();
      git(["reset", "--hard", "HEAD"]);

      git(["mv", "system/locked.md", "system/renamed.md"]);
      expect(() => git(["commit", "-m", "rename"])).toThrow();
      git(["reset", "--hard", "HEAD"]);

      const exitCode = await runMemoryReadOnlyAction({
        agentId: "agent-fixture",
        memoryDir: dir,
        path: "system/locked.md",
        value: "false",
        extraPositionals: [],
      });
      expect(exitCode).toBe(0);

      expect(readFileSync(file, "utf8")).toContain("read_only: false");
      expect(git(["log", "-1", "--pretty=%s"]).trim()).toBe(
        "Unmark system/locked.md as read-only",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
