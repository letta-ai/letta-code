import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { bash } from "@/tools/impl/bash";

async function runBashInTemp(
  command: string,
  args: Partial<Parameters<typeof bash>[0]> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "letta-bash-worktree-test-"));
  try {
    return await runWithRuntimeContext({ workingDirectory: dir }, () =>
      bash({
        command,
        description: "Test worktree path handling",
        ...args,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Bash tool", () => {
  test("executes simple command", async () => {
    const result = await bash({
      command: "echo 'Hello, World!'",
      description: "Test echo",
    });

    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toContain("Hello, World!");
    expect(result.status).toBe("success");
  });

  test("captures stderr in output", async () => {
    const result = await bash({
      command: "echo 'error message' >&2",
      description: "Test stderr",
    });

    expect(result.content[0]?.text).toContain("error message");
  });

  test("returns error for failed command", async () => {
    const result = await bash({
      command: "exit 1",
      description: "Test exit code",
    });

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("Exit code");
  });

  test("strict mode fails fast on intermediate shell errors", async () => {
    if (process.platform === "win32") return;

    const result = await runBashInTemp(
      [
        "cat > missing-dir/SKILL.md <<'EOF'",
        "contents",
        "EOF",
        "echo 'SKILL.md written successfully'",
      ].join("\n"),
      {
        description: "Test strict mode",
        secretEnv: { LETTA_BASH_STRICT: "1" },
      },
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("missing-dir/SKILL.md");
    expect(result.content[0]?.text).not.toContain(
      "SKILL.md written successfully",
    );
  });

  test("times out long-running command", async () => {
    const result = await bash({
      command: "sleep 10",
      description: "Test timeout",
      timeout: 100,
    });

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("timed out");
  }, 2000);

  test("runs command in background mode", async () => {
    const result = await bash({
      command: "echo 'background'",
      description: "Test background",
      run_in_background: true,
    });

    expect(result.content[0]?.text).toContain("background with ID:");
    expect(result.content[0]?.text).toMatch(/bash_\d+/);
  });

  test("handles complex commands with pipes", async () => {
    // Skip on Windows - pipe syntax is different
    if (process.platform === "win32") {
      return;
    }

    const result = await bash({
      command: "echo -e 'foo\\nbar\\nbaz' | grep bar",
      description: "Test pipe",
    });

    expect(result.content[0]?.text).toContain("bar");
    expect(result.content[0]?.text).not.toContain("foo");
  });

  test("lists background processes with /bg command", async () => {
    const result = await bash({
      command: "/bg",
      description: "List processes",
    });

    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toBeDefined();
  });

  test("throws error when command is missing", async () => {
    await expect(bash({} as Parameters<typeof bash>[0])).rejects.toThrow(
      /missing required parameter.*command/,
    );
  });

  test("does not hardcode git worktree add paths", async () => {
    const result = await runBashInTemp(
      "git worktree add -b fix/feature ../my-worktree main",
    );

    expect(result.content[0]?.text).not.toContain(
      "Worktrees must be created under .letta/worktrees/",
    );
  });

  test("allows git worktree add under .letta/worktrees/", async () => {
    // This tests the validation only — the command itself will fail
    // because there's no git repo, but it should NOT be blocked by
    // the worktree path check.
    const result = await runBashInTemp(
      "git worktree add -b fix/feature .letta/worktrees/my-feature main",
    );

    // Should fail with a git error (not our validation error)
    expect(result.content[0]?.text).not.toContain(
      "Worktrees must be created under .letta/worktrees/",
    );
  });

  test("does not hardcode env-prefixed git worktree add paths", async () => {
    const result = await runBashInTemp(
      "FOO=1 env -i BAR=2 git worktree add -b fix/feature ../my-worktree main",
    );

    expect(result.content[0]?.text).not.toContain(
      "Worktrees must be created under .letta/worktrees/",
    );
  });
});
