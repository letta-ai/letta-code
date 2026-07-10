import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { bash, spawnCommand } from "@/tools/impl/bash";
import { backgroundProcesses } from "@/tools/impl/process_manager";

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
      command:
        process.platform === "win32"
          ? "node -e \"console.log('Hello, World!')\""
          : "echo 'Hello, World!'",
      description: "Test echo",
    });

    expect(result.content).toBeDefined();
    expect(result.content[0]?.text).toContain("Hello, World!");
    expect(result.status).toBe("success");
  });

  test("captures stderr in output", async () => {
    const result = await bash({
      command:
        process.platform === "win32"
          ? "node -e \"console.error('error message')\""
          : "echo 'error message' >&2",
      description: "Test stderr",
    });

    expect(result.content[0]?.text).toContain("error message");
  });

  test("recovers when runtime working directory was deleted mid-turn", async () => {
    // Resolve symlinks/8.3 short names (macOS /var -> /private/var, Windows
    // RUNNER~1 -> runneradmin) so the assertion matches the child's cwd.
    const fallbackDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "letta-bash-fallback-")),
    );
    const deletedDir = await mkdtemp(
      path.join(tmpdir(), "letta-bash-deleted-"),
    );
    await rm(deletedDir, { recursive: true, force: true });

    const originalUserCwd = process.env.USER_CWD;
    process.env.USER_CWD = fallbackDir;

    try {
      const result = await runWithRuntimeContext(
        { workingDirectory: deletedDir },
        () =>
          bash({
            command: 'node -e "console.log(process.cwd())"',
            description: "Test missing cwd recovery",
          }),
      );

      expect(result.status).toBe("success");
      expect(result.content[0]?.text).toContain(fallbackDir);
      expect(result.content[0]?.text).not.toContain("Executable not found");
      // The model must be told its cwd changed instead of silently running
      // from a different directory.
      expect(result.content[0]?.text).toContain(
        `Note: working directory ${deletedDir} no longer exists`,
      );
    } finally {
      if (originalUserCwd === undefined) delete process.env.USER_CWD;
      else process.env.USER_CWD = originalUserCwd;
      await rm(fallbackDir, { recursive: true, force: true });
    }
  });

  test("reports missing explicit cwd instead of missing shell", async () => {
    const missingDir = path.join(
      tmpdir(),
      `letta-bash-missing-${Date.now()}-${Math.random()}`,
    );

    await expect(
      spawnCommand("node -e \"console.log('unused')\"", {
        cwd: missingDir,
        env: process.env,
        timeout: 1000,
      }),
    ).rejects.toThrow(`Working directory not found: ${missingDir}`);
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

  test("background mode falls back to available Windows PowerShell when pwsh is unavailable", async () => {
    if (process.platform === "win32") return;

    const tempDir = await mkdtemp(path.join(tmpdir(), "letta-bash-win-bg-"));
    const fakePowerShell = path.join(tempDir, "powershell");
    await writeFile(
      fakePowerShell,
      "#!/bin/sh\nprintf fake-background-powershell\n",
      {
        mode: 0o755,
      },
    );

    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    const startedIds: string[] = [];

    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PATH = tempDir;
    delete process.env.PATHEXT;

    try {
      const result = await bash({
        command: "ignored",
        description: "Test Windows PowerShell fallback",
        run_in_background: true,
      });

      expect(result.status).toBe("success");
      const bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
      expect(bashId).toBeDefined();
      if (!bashId) throw new Error("Expected background Bash id");
      startedIds.push(bashId);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const processEntry = backgroundProcesses.get(bashId);
        if (
          processEntry?.status !== "running" ||
          processEntry?.stdout.join("\n").includes("fake-background-powershell")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const processEntry = backgroundProcesses.get(bashId);
      expect(processEntry?.stdout.join("\n")).toContain(
        "fake-background-powershell",
      );
      expect(processEntry?.exitCode).toBe(0);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathext;

      for (const id of startedIds) {
        const processEntry = backgroundProcesses.get(id);
        try {
          processEntry?.process.kill("SIGTERM");
        } catch {
          // Ignore already-completed processes.
        }
        if (processEntry?.outputFile) {
          await rm(processEntry.outputFile, { force: true });
        }
        backgroundProcesses.delete(id);
      }
      await rm(tempDir, { recursive: true, force: true });
    }
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
