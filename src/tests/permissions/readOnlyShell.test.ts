import { describe, expect, test } from "bun:test";
import { isReadOnlyShellCommand } from "../../permissions/readOnlyShell";

describe("isReadOnlyShellCommand", () => {
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

    test("blocks unknown commands", () => {
      expect(isReadOnlyShellCommand("rm file")).toBe(false);
      expect(isReadOnlyShellCommand("mv a b")).toBe(false);
      expect(isReadOnlyShellCommand("chmod 755 file")).toBe(false);
      expect(isReadOnlyShellCommand("curl http://example.com")).toBe(false);
    });
  });
});
