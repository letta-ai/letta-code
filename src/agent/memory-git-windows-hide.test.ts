import { afterEach, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const originalExecFile = childProcess.execFile;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFileSync = childProcess.execFileSync;

afterEach(() => mock.restore());

test("hides direct Git and validator launches for MemFS operations and the viewer", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { windowsHide?: boolean };
  }> = [];
  const execFileMock = Object.assign(
    (
      command: string,
      args: string[],
      options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ command, args, options });
      return originalExecFile(command, args, options, callback);
    },
    {
      [promisify.custom]: async (
        command: string,
        args: string[],
        options: object,
      ) => {
        calls.push({ command, args, options });
        return promisify(originalExecFile)(command, args, options);
      },
    },
  );
  mock.module("node:child_process", () => ({
    ...childProcess,
    execFile: execFileMock,
    spawnSync: (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return originalSpawnSync(command, args, options);
    },
    execFileSync: (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return originalExecFileSync(command, args, options);
    },
  }));
  const { createReflectionMemoryWorktree } = await import("./memory-worktree");
  const { hasRootMemoryMarker } = await import("./memory-git-hooks");
  const { validateMemoryConstraintsHead } = await import(
    "./memory-constraints-audit"
  );
  const { runGitSafe } = await import("@/web/generate-memory-viewer");
  const root = mkdtempSync(join(tmpdir(), "memory-git-hide-"));
  const repo = join(root, "memory");
  try {
    mkdirSync(repo);
    originalExecFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    originalExecFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ],
      { cwd: repo },
    );
    await createReflectionMemoryWorktree({ parentMemoryDir: repo });
    hasRootMemoryMarker(repo);
    expect((await runGitSafe(repo, ["rev-parse", "HEAD"])).trim()).toHaveLength(
      40,
    );
    expect(validateMemoryConstraintsHead(repo).valid).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("worktree"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("read-tree"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) => command === "git" && args.includes("cat-file"),
      ),
    ).toBe(true);
    expect(calls.some(({ command }) => command === process.execPath)).toBe(
      true,
    );
    expect(calls.every((call) => call.options.windowsHide === true)).toBe(true);
  } finally {
    mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
