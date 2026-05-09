import { describe, expect, test } from "bun:test";
import { classifyMemoryBashDenial } from "../../permissions/memoryDenialReason";

const memDir = "/Users/test/.letta/agents/agent-1/memory";
const roots = [memDir];
const env = {
  MEMORY_DIR: memDir,
  LETTA_AGENT_ID: "agent-1",
  HOME: "/Users/test",
} as NodeJS.ProcessEnv;
const opts = { workingDirectory: memDir, env };

describe("classifyMemoryBashDenial", () => {
  describe("cmdsub category", () => {
    test("flags `$()` substitution outside quotes", () => {
      const result = classifyMemoryBashDenial(
        "CHILD=$(echo $LETTA_AGENT_ID) && echo $CHILD",
        roots,
        opts,
      );
      expect(result.category).toBe("cmdsub");
      expect(result.reason).toContain("command substitution");
      expect(result.reason).toContain("$LETTA_AGENT_ID");
    });

    test("flags `$()` substitution inside double quotes", () => {
      const result = classifyMemoryBashDenial(
        'git commit -m "...$(echo $LETTA_AGENT_ID)..."',
        roots,
        opts,
      );
      expect(result.category).toBe("cmdsub");
    });

    test("flags backtick substitution", () => {
      const result = classifyMemoryBashDenial(
        'echo "rev=`git rev-parse HEAD`"',
        roots,
        opts,
      );
      expect(result.category).toBe("cmdsub");
      expect(result.reason).toContain("`cmd`");
    });

    test("does NOT flag `$()` literal inside single quotes", () => {
      const result = classifyMemoryBashDenial(
        "echo '$(this is just text)'",
        roots,
        opts,
      );
      expect(result.category).not.toBe("cmdsub");
    });

    test("does NOT flag backtick literal inside single quotes", () => {
      const result = classifyMemoryBashDenial(
        "echo '`literal backticks`'",
        roots,
        opts,
      );
      expect(result.category).not.toBe("cmdsub");
    });
  });

  describe("unsafe-cmd category", () => {
    test("flags python3 invocation", () => {
      const result = classifyMemoryBashDenial(
        'python3 -c "print(1)"',
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
      expect(result.reason).toContain("python3");
      expect(result.reason).toContain("heredoc");
      expect(result.reason).toContain('cat > "$MEMORY_DIR/');
    });

    test("flags python3 with leading env var", () => {
      const result = classifyMemoryBashDenial(
        'PYTHONPATH=/foo python3 -c "print(1)"',
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
      expect(result.reason).toContain("python3");
    });

    test("flags sed -i", () => {
      const result = classifyMemoryBashDenial(
        `sed -i s/old/new/ "$MEMORY_DIR/x.md"`,
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
      expect(result.reason).toContain("sed");
    });

    test("flags curl, tee, awk", () => {
      for (const verb of ["curl", "tee", "awk", "perl", "node"]) {
        const result = classifyMemoryBashDenial(`${verb} foo`, roots, opts);
        expect(result.category).toBe("unsafe-cmd");
        expect(result.reason).toContain(verb);
      }
    });

    test("flags absolute-path python3", () => {
      const result = classifyMemoryBashDenial(
        `/usr/bin/python3 -c "print(1)"`,
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
      expect(result.reason).toContain("python3");
    });

    test("does NOT flag unsafe verb appearing inside heredoc body", () => {
      const result = classifyMemoryBashDenial(
        [
          `cat > "$MEMORY_DIR/x.md" << 'EOF'`,
          "import python  # this should not trigger unsafe-cmd",
          "sed_example: yes",
          "EOF",
        ].join("\n"),
        roots,
        opts,
      );
      expect(result.category).not.toBe("unsafe-cmd");
    });

    test("does NOT flag safe binaries (cat, git, printf)", () => {
      for (const cmd of [
        "cat foo.txt",
        "git status",
        `printf "hi" > "$MEMORY_DIR/x.md"`,
      ]) {
        const result = classifyMemoryBashDenial(cmd, roots, opts);
        expect(result.category).not.toBe("unsafe-cmd");
      }
    });
  });

  describe("redirect-outside-roots category", () => {
    test("flags redirect to /tmp", () => {
      const result = classifyMemoryBashDenial(
        `echo hi > /tmp/x.md`,
        roots,
        opts,
      );
      expect(result.category).toBe("redirect-outside-roots");
      expect(result.reason).toContain("/tmp/x.md");
      expect(result.reason).toContain("$MEMORY_DIR");
    });

    test("flags append-redirect outside roots", () => {
      const result = classifyMemoryBashDenial(
        `echo hi >> /tmp/x.md`,
        roots,
        opts,
      );
      expect(result.category).toBe("redirect-outside-roots");
    });

    test("does NOT flag redirect to /dev/null", () => {
      const result = classifyMemoryBashDenial(
        `echo hi > /dev/null 2>&1`,
        roots,
        opts,
      );
      expect(result.category).not.toBe("redirect-outside-roots");
    });

    test("does NOT flag redirect to fd dup (>&2)", () => {
      const result = classifyMemoryBashDenial(`echo hi >&2`, roots, opts);
      expect(result.category).not.toBe("redirect-outside-roots");
    });

    test("does NOT flag redirect inside MEMORY_DIR", () => {
      const result = classifyMemoryBashDenial(
        `echo hi > "$MEMORY_DIR/x.md"`,
        roots,
        opts,
      );
      expect(result.category).not.toBe("redirect-outside-roots");
    });

    test("does NOT flag redirect-shaped chars inside heredoc body", () => {
      const result = classifyMemoryBashDenial(
        [
          `cat > "$MEMORY_DIR/x.md" << 'EOF'`,
          "code: foo > /tmp/bar # not a real redirect",
          "EOF",
        ].join("\n"),
        roots,
        opts,
      );
      expect(result.category).not.toBe("redirect-outside-roots");
    });
  });

  describe("path-outside-roots category", () => {
    test("flags absolute path outside roots in non-redirect context", () => {
      const result = classifyMemoryBashDenial(`cd /tmp && ls`, roots, opts);
      expect(result.category).toBe("path-outside-roots");
      expect(result.reason).toContain("$MEMORY_DIR");
    });

    test("falls through to other for bare-relative commands", () => {
      // No absolute paths, no redirect, no unsafe verb, no cmdsub.
      const result = classifyMemoryBashDenial(
        `git push origin main`,
        roots,
        opts,
      );
      expect(result.category).toBe("other");
    });
  });

  describe("other category (final fallback)", () => {
    test("uses generic guidance when no specific signal is found", () => {
      const result = classifyMemoryBashDenial(
        `someweirdcommand --foo bar`,
        roots,
        opts,
      );
      expect(result.category).toBe("other");
      expect(result.reason).toContain("Allowed shapes");
      expect(result.reason).toContain("$MEMORY_DIR");
    });
  });

  describe("ordering / precedence", () => {
    test("cmdsub takes precedence over unsafe-cmd", () => {
      const result = classifyMemoryBashDenial(
        `python3 -c "print($(date +%s))"`,
        roots,
        opts,
      );
      expect(result.category).toBe("cmdsub");
    });

    test("unsafe-cmd takes precedence over redirect", () => {
      const result = classifyMemoryBashDenial(
        `python3 -c "print(1)" > /tmp/x.md`,
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
    });
  });

  describe("array command input", () => {
    test("accepts a string[] command and joins it", () => {
      const result = classifyMemoryBashDenial(
        ["python3", "-c", "print(1)"],
        roots,
        opts,
      );
      expect(result.category).toBe("unsafe-cmd");
      expect(result.reason).toContain("python3");
    });
  });
});
