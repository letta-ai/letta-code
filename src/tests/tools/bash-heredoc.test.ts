import { describe, expect, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";

const isWindows = process.platform === "win32";

// HEREDOC is bash/zsh syntax, not available in PowerShell
describe.skipIf(isWindows)("Bash HEREDOC support", () => {
  test("simple HEREDOC works", async () => {
    const result = await bash({
      command: `cat <<'EOF'
hello world
EOF`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("hello world");
  });

  test("HEREDOC with command substitution works", async () => {
    const result = await bash({
      command: `echo "$(cat <<'EOF'
hello world
EOF
)"`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("hello world");
  });

  test("HEREDOC with apostrophe in content works", async () => {
    const result = await bash({
      command: `cat <<'EOF'
user's preference
EOF`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("user's preference");
  });

  test("HEREDOC with apostrophe in command substitution works", async () => {
    const result = await bash({
      command: `echo "$(cat <<'EOF'
user's preference
EOF
)"`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("user's preference");
  });

  test("git commit style HEREDOC works", async () => {
    // Simulates the pattern used for git commits
    const result = await bash({
      command: `echo "$(cat <<'EOF'
feat: add user's preferences

This handles the user's settings correctly.

🤖 Generated with [Letta Code](https://letta.com)

Co-Authored-By: Letta Code <noreply@letta.com>
EOF
)"`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("user's preferences");
    expect(result.content[0]?.text).toContain("user's settings");
  });

  test("HEREDOC with multiple apostrophes works", async () => {
    const result = await bash({
      command: `cat <<'EOF'
It's the user's file in John's directory
EOF`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain(
      "It's the user's file in John's directory",
    );
  });

  test("HEREDOC with special characters works", async () => {
    const result = await bash({
      command: `cat <<'EOF'
Special chars: $VAR \`backticks\` "quotes" 'apostrophes'
EOF`,
    });
    expect(result.status).toBe("success");
    // With <<'EOF' (quoted), these should be literal, not expanded
    expect(result.content[0]?.text).toContain("$VAR");
    expect(result.content[0]?.text).toContain("`backticks`");
  });

  test("multiline git commit message HEREDOC", async () => {
    const result = await bash({
      command: `cat <<'EOF'
fix: handle user's preferences correctly

- Fixed the user's settings page
- Added Sarah's requested feature
- Updated John's component

🤖 Generated with [Letta Code](https://letta.com)

Co-Authored-By: Letta Code <noreply@letta.com>
EOF`,
    });
    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("user's preferences");
    expect(result.content[0]?.text).toContain("Sarah's requested");
    expect(result.content[0]?.text).toContain("John's component");
  });
});
