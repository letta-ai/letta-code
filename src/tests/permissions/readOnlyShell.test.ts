import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  isMemoryDirCommand,
  isReadOnlyShellCommand,
} from "../../permissions/readOnlyShell";

describe("isReadOnlyShellCommand", () => {
  describe("path restrictions", () => {
    test("blocks external paths by default", () => {
      expect(isReadOnlyShellCommand("cat /etc/passwd")).toBe(false);
      expect(isReadOnlyShellCommand("head -n 20 ../../../.ssh/id_rsa")).toBe(
        false,
      );
    });

    test("allows external paths when explicitly enabled", () => {
      expect(
        isReadOnlyShellCommand("cat /etc/passwd", {
          allowExternalPaths: true,
        }),
      ).toBe(true);
      expect(
        isReadOnlyShellCommand("head -n 20 ../../../.ssh/id_rsa", {
          allowExternalPaths: true,
        }),
      ).toBe(true);
      expect(
        isReadOnlyShellCommand("cd / && cat etc/passwd", {
          allowExternalPaths: true,
        }),
      ).toBe(true);
    });
  });

  describe("always safe commands", () => {
    test("allows cat", () => {
      expect(isReadOnlyShellCommand("cat file.txt")).toBe(true);
    });

    test("allows grep", () => {
      expect(isReadOnlyShellCommand("grep -r 'pattern' .")).toBe(true);
    });

    test("allows ls", () => {
      expect(isReadOnlyShellCommand("ls -la")).toBe(true);
    });

    test("allows head/tail", () => {
      expect(isReadOnlyShellCommand("head -n 10 file.txt")).toBe(true);
      expect(isReadOnlyShellCommand("tail -f log.txt")).toBe(true);
    });

    test("allows wc", () => {
      expect(isReadOnlyShellCommand("wc -l file.txt")).toBe(true);
    });

    test("allows diff", () => {
      expect(isReadOnlyShellCommand("diff file1.txt file2.txt")).toBe(true);
    });

    test("allows jq", () => {
      expect(isReadOnlyShellCommand("jq '.foo' file.json")).toBe(true);
    });

    test("allows pwd, whoami, date, etc", () => {
      expect(isReadOnlyShellCommand("pwd")).toBe(true);
      expect(isReadOnlyShellCommand("whoami")).toBe(true);
      expect(isReadOnlyShellCommand("date")).toBe(true);
      expect(isReadOnlyShellCommand("hostname")).toBe(true);
    });
  });

  describe("git commands", () => {
    test("allows read-only git commands", () => {
      expect(isReadOnlyShellCommand("git status")).toBe(true);
      expect(isReadOnlyShellCommand("git diff")).toBe(true);
      expect(isReadOnlyShellCommand("git log")).toBe(true);
      expect(isReadOnlyShellCommand("git show HEAD")).toBe(true);
      expect(isReadOnlyShellCommand("git branch -a")).toBe(true);
    });

    test("blocks write git commands", () => {
      expect(isReadOnlyShellCommand("git push")).toBe(false);
      expect(isReadOnlyShellCommand("git commit -m 'msg'")).toBe(false);
      expect(isReadOnlyShellCommand("git reset --hard")).toBe(false);
      expect(isReadOnlyShellCommand("git checkout branch")).toBe(false);
    });

    test("blocks bare git", () => {
      expect(isReadOnlyShellCommand("git")).toBe(false);
    });
  });

  describe("gh commands", () => {
    test("allows read-only gh pr commands", () => {
      expect(isReadOnlyShellCommand("gh pr list")).toBe(true);
      expect(isReadOnlyShellCommand("gh pr view 123")).toBe(true);
      expect(isReadOnlyShellCommand("gh pr diff 123")).toBe(true);
      expect(isReadOnlyShellCommand("gh pr checks 123")).toBe(true);
      expect(isReadOnlyShellCommand("gh pr status")).toBe(true);
      expect(
        isReadOnlyShellCommand(
          "gh pr list --state merged --limit 20 --json number,title",
        ),
      ).toBe(true);
    });

    test("blocks write gh pr commands", () => {
      expect(isReadOnlyShellCommand("gh pr create")).toBe(false);
      expect(isReadOnlyShellCommand("gh pr merge 123")).toBe(false);
      expect(isReadOnlyShellCommand("gh pr close 123")).toBe(false);
      expect(isReadOnlyShellCommand("gh pr edit 123")).toBe(false);
    });

    test("allows read-only gh issue commands", () => {
      expect(isReadOnlyShellCommand("gh issue list")).toBe(true);
      expect(isReadOnlyShellCommand("gh issue view 123")).toBe(true);
      expect(isReadOnlyShellCommand("gh issue status")).toBe(true);
    });

    test("blocks write gh issue commands", () => {
      expect(isReadOnlyShellCommand("gh issue create")).toBe(false);
      expect(isReadOnlyShellCommand("gh issue close 123")).toBe(false);
    });

    test("allows gh search commands", () => {
      expect(isReadOnlyShellCommand("gh search repos letta")).toBe(true);
      expect(isReadOnlyShellCommand("gh search issues bug")).toBe(true);
      expect(isReadOnlyShellCommand("gh search prs fix")).toBe(true);
    });

    test("allows gh api commands", () => {
      expect(isReadOnlyShellCommand("gh api repos/owner/repo")).toBe(true);
      expect(
        isReadOnlyShellCommand("gh api repos/owner/repo/pulls/123/comments"),
      ).toBe(true);
    });

    test("allows gh status command", () => {
      expect(isReadOnlyShellCommand("gh status")).toBe(true);
    });

    test("blocks unsafe gh categories", () => {
      expect(isReadOnlyShellCommand("gh auth login")).toBe(false);
      expect(isReadOnlyShellCommand("gh config set")).toBe(false);
      expect(isReadOnlyShellCommand("gh secret set")).toBe(false);
    });

    test("blocks bare gh", () => {
      expect(isReadOnlyShellCommand("gh")).toBe(false);
    });

    test("blocks gh with unknown category", () => {
      expect(isReadOnlyShellCommand("gh unknown")).toBe(false);
    });
  });

  describe("find command", () => {
    test("allows safe find", () => {
      expect(isReadOnlyShellCommand("find . -name '*.js'")).toBe(true);
      expect(isReadOnlyShellCommand("find /tmp -type f")).toBe(true);
    });

    test("blocks find with -delete", () => {
      expect(isReadOnlyShellCommand("find . -name '*.tmp' -delete")).toBe(
        false,
      );
    });

    test("blocks find with -exec", () => {
      expect(isReadOnlyShellCommand("find . -exec rm {} \\;")).toBe(false);
    });
  });

  describe("sort command", () => {
    test("allows safe sort", () => {
      expect(isReadOnlyShellCommand("sort file.txt")).toBe(true);
      expect(isReadOnlyShellCommand("sort -n numbers.txt")).toBe(true);
    });

    test("blocks sort with -o (output to file)", () => {
      expect(isReadOnlyShellCommand("sort -o output.txt input.txt")).toBe(
        false,
      );
    });
  });

  describe("pipes", () => {
    test("allows safe pipes", () => {
      expect(isReadOnlyShellCommand("cat file | grep pattern")).toBe(true);
      expect(isReadOnlyShellCommand("grep foo | head -10")).toBe(true);
      expect(isReadOnlyShellCommand("ls -la | grep txt | wc -l")).toBe(true);
    });

    test("allows pipe characters inside quoted args", () => {
      expect(isReadOnlyShellCommand('rg -n "foo|bar|baz" apps/core')).toBe(
        true,
      );
    });

    test("blocks pipes with unsafe commands", () => {
      expect(isReadOnlyShellCommand("cat file | rm")).toBe(false);
      expect(isReadOnlyShellCommand("echo test | bash")).toBe(false);
    });
  });

  describe("dangerous operators", () => {
    test("blocks output redirection", () => {
      expect(isReadOnlyShellCommand("cat file > output.txt")).toBe(false);
      expect(isReadOnlyShellCommand("cat file >> output.txt")).toBe(false);
    });

    test("blocks command chaining", () => {
      expect(isReadOnlyShellCommand("ls && rm file")).toBe(false);
      expect(isReadOnlyShellCommand("ls || rm file")).toBe(false);
      expect(isReadOnlyShellCommand("ls; rm file")).toBe(false);
    });

    test("blocks command substitution", () => {
      expect(isReadOnlyShellCommand("echo $(rm file)")).toBe(false);
      expect(isReadOnlyShellCommand("echo `rm file`")).toBe(false);
      expect(isReadOnlyShellCommand('echo "$(rm file)"')).toBe(false);
      expect(isReadOnlyShellCommand('echo "`rm file`"')).toBe(false);
    });

    test("allows literal redirect text inside quotes", () => {
      expect(isReadOnlyShellCommand('echo "a > b"')).toBe(true);
      expect(isReadOnlyShellCommand("echo 'a >> b'")).toBe(true);
    });
  });

  describe("bash -c handling", () => {
    test("allows bash -c with safe command", () => {
      expect(isReadOnlyShellCommand("bash -c 'cat file.txt'")).toBe(true);
      expect(isReadOnlyShellCommand("sh -c 'grep pattern file'")).toBe(true);
    });

    test("allows bash -lc with safe command", () => {
      expect(isReadOnlyShellCommand("bash -lc cat package.json")).toBe(true);
    });

    test("blocks bash -c with unsafe command", () => {
      expect(isReadOnlyShellCommand("bash -c 'rm file'")).toBe(false);
      expect(isReadOnlyShellCommand("sh -c 'echo foo > file'")).toBe(false);
    });

    test("blocks bare bash/sh", () => {
      expect(isReadOnlyShellCommand("bash")).toBe(false);
      expect(isReadOnlyShellCommand("bash script.sh")).toBe(false);
    });
  });

  describe("array commands", () => {
    test("handles array format", () => {
      expect(isReadOnlyShellCommand(["cat", "file.txt"])).toBe(true);
      expect(isReadOnlyShellCommand(["rm", "file.txt"])).toBe(false);
    });

    test("handles bash -c in array format", () => {
      expect(isReadOnlyShellCommand(["bash", "-c", "cat file"])).toBe(true);
      expect(isReadOnlyShellCommand(["bash", "-lc", "cat file"])).toBe(true);
      expect(isReadOnlyShellCommand(["bash", "-c", "rm file"])).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("handles empty/null input", () => {
      expect(isReadOnlyShellCommand("")).toBe(false);
      expect(isReadOnlyShellCommand(null)).toBe(false);
      expect(isReadOnlyShellCommand(undefined)).toBe(false);
      expect(isReadOnlyShellCommand([])).toBe(false);
    });

    test("handles whitespace", () => {
      expect(isReadOnlyShellCommand("   cat file.txt   ")).toBe(true);
      expect(isReadOnlyShellCommand("  ")).toBe(false);
    });

    test("allows relative cd chaining with read-only git", () => {
      expect(isReadOnlyShellCommand("cd src && git status")).toBe(true);
    });

    test("blocks unknown commands", () => {
      expect(isReadOnlyShellCommand("rm file")).toBe(false);
      expect(isReadOnlyShellCommand("mv a b")).toBe(false);
      expect(isReadOnlyShellCommand("chmod 755 file")).toBe(false);
      expect(isReadOnlyShellCommand("curl http://example.com")).toBe(false);
    });
  });
});

describe("isMemoryDirCommand", () => {
  const AGENT_ID = "agent-test-abc123";
  // Normalize to forward slashes for shell command strings (even on Windows)
  const home = homedir().replace(/\\/g, "/");
  const memDir = `${home}/.letta/agents/${AGENT_ID}/memory`;
  const worktreeDir = `${home}/.letta/agents/${AGENT_ID}/memory-worktrees`;

  describe("git operations in memory dir", () => {
    test("allows git add", () => {
      expect(isMemoryDirCommand(`cd ${memDir} && git add -A`, AGENT_ID)).toBe(
        true,
      );
    });

    test("allows git commit", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git commit -m 'update memory'`,
          AGENT_ID,
        ),
      ).toBe(true);
    });

    test("allows git push", () => {
      expect(isMemoryDirCommand(`cd ${memDir} && git push`, AGENT_ID)).toBe(
        true,
      );
    });

    test("allows git rm", () => {
      expect(
        isMemoryDirCommand(`cd ${memDir} && git rm file.md`, AGENT_ID),
      ).toBe(true);
    });

    test("allows git mv", () => {
      expect(
        isMemoryDirCommand(`cd ${memDir} && git mv a.md b.md`, AGENT_ID),
      ).toBe(true);
    });

    test("allows git merge", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git merge migration-branch --no-edit`,
          AGENT_ID,
        ),
      ).toBe(true);
    });

    test("allows git worktree add", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git worktree add ../memory-worktrees/branch-1 -b branch-1`,
          AGENT_ID,
        ),
      ).toBe(true);
    });
  });

  describe("chained commands in memory dir", () => {
    test("allows git add + commit + push chain", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git add -A && git commit -m 'msg' && git push`,
          AGENT_ID,
        ),
      ).toBe(true);
    });

    test("allows git ls-tree piped to sort", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git ls-tree -r --name-only HEAD | sort`,
          AGENT_ID,
        ),
      ).toBe(true);
    });

    test("allows git status + git diff chain", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git status --short && git diff --stat`,
          AGENT_ID,
        ),
      ).toBe(true);
    });
  });

  describe("git with auth header", () => {
    test("allows git push with http.extraHeader", () => {
      expect(
        isMemoryDirCommand(
          `cd ${memDir} && git -c "http.extraHeader=Authorization: Basic abc123" push`,
          AGENT_ID,
        ),
      ).toBe(true);
    });
  });

  describe("worktree paths", () => {
    test("allows git add in worktree", () => {
      expect(
        isMemoryDirCommand(
          `cd ${worktreeDir}/migration-123 && git add -A`,
          AGENT_ID,
        ),
      ).toBe(true);
    });

    test("allows git commit in worktree", () => {
      expect(
        isMemoryDirCommand(
          `cd ${worktreeDir}/migration-123 && git commit -m 'analysis'`,
          AGENT_ID,
        ),
      ).toBe(true);
    });
  });

  describe("file operations in memory dir", () => {
    test("allows rm in memory dir", () => {
      expect(isMemoryDirCommand(`rm -rf ${memDir}/memory`, AGENT_ID)).toBe(
        true,
      );
    });

    test("allows mkdir in memory dir", () => {
      expect(
        isMemoryDirCommand(`mkdir -p ${memDir}/system/project`, AGENT_ID),
      ).toBe(true);
    });
  });

  describe("tilde path expansion", () => {
    test("allows tilde-based memory dir path", () => {
      expect(
        isMemoryDirCommand(
          `cd ~/.letta/agents/${AGENT_ID}/memory && git status`,
          AGENT_ID,
        ),
      ).toBe(true);
    });
  });

  describe("blocks other agent's memory", () => {
    test("blocks different agent ID", () => {
      expect(
        isMemoryDirCommand(
          `cd ${home}/.letta/agents/agent-OTHER-456/memory && git push`,
          AGENT_ID,
        ),
      ).toBe(false);
    });
  });

  describe("blocks commands outside memory dir", () => {
    test("blocks project directory git push", () => {
      expect(
        isMemoryDirCommand(
          "cd /Users/loaner/dev/project && git push",
          AGENT_ID,
        ),
      ).toBe(false);
    });

    test("blocks bare git push with no cd", () => {
      expect(isMemoryDirCommand("git push", AGENT_ID)).toBe(false);
    });

    test("blocks curl even with no path context", () => {
      expect(isMemoryDirCommand("curl http://evil.com", AGENT_ID)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("allows bare cd to memory dir", () => {
      expect(isMemoryDirCommand(`cd ${memDir}`, AGENT_ID)).toBe(true);
    });

    test("returns false for empty input", () => {
      expect(isMemoryDirCommand("", AGENT_ID)).toBe(false);
      expect(isMemoryDirCommand(null, AGENT_ID)).toBe(false);
      expect(isMemoryDirCommand(undefined, AGENT_ID)).toBe(false);
    });

    test("returns false for empty agent ID", () => {
      expect(isMemoryDirCommand(`cd ${memDir} && git push`, "")).toBe(false);
    });
  });
});
