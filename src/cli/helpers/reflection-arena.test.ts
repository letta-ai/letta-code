import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReflectionMemoryWorktree } from "@/agent/memory-worktree";
import { reflectionMemoryWorktreeHasNoChanges } from "@/cli/helpers/reflection-arena";
import { getReflectionFinalizationContext } from "@/cli/helpers/reflection-launcher";
import { settingsManager } from "@/settings-manager";

let tempDir: string;
let memoryDir: string;

const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSettings = settingsManager.getSettings;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflection-arena-worktree-"));
  memoryDir = join(tempDir, "agent", "memory");
  git(tempDir, ["init", "-b", "main", memoryDir]);
  writeFileSync(join(memoryDir, "persona.md"), "base\n", "utf-8");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  (settingsManager as typeof settingsManager).getLocalProjectSettings =
    originalGetLocalProjectSettings;
  (settingsManager as typeof settingsManager).getSettings = originalGetSettings;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reflection arena finalization", () => {
  test("uses the owning agent's explicit merge settings", () => {
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({
        reflectionSettingsByAgent: {
          "agent-arena-owner": {
            merge: "explicit",
            mergeInstructions: "Preserve the winning proposal's intent.",
          },
          "agent-selected-elsewhere": {
            merge: "auto",
            mergeInstructions: "",
          },
        },
      }) as unknown as ReturnType<
        typeof settingsManager.getLocalProjectSettings
      >;
    (settingsManager as typeof settingsManager).getSettings =
      (() => ({})) as typeof settingsManager.getSettings;

    expect(getReflectionFinalizationContext("agent-arena-owner")).toEqual({
      agentId: "agent-arena-owner",
      mergePolicy: "explicit",
      mergeInstructions: "Preserve the winning proposal's intent.",
    });
    expect(
      getReflectionFinalizationContext("agent-selected-elsewhere"),
    ).toEqual({
      agentId: "agent-selected-elsewhere",
      mergePolicy: "auto",
      mergeInstructions: "",
    });
  });
});

describe("reflection arena worktree snapshots", () => {
  test("identifies a clean no-op worktree", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    expect(await reflectionMemoryWorktreeHasNoChanges(worktree)).toBe(true);
  });

  test("rejects committed and uncommitted memory changes", async () => {
    const committedWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(committedWorktree.worktreeDir, "committed.md"),
      "committed\n",
      "utf-8",
    );
    git(committedWorktree.worktreeDir, ["add", "committed.md"]);
    git(committedWorktree.worktreeDir, ["commit", "-m", "committed"]);

    const dirtyWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(dirtyWorktree.worktreeDir, "dirty.md"),
      "dirty\n",
      "utf-8",
    );

    expect(await reflectionMemoryWorktreeHasNoChanges(committedWorktree)).toBe(
      false,
    );
    expect(await reflectionMemoryWorktreeHasNoChanges(dirtyWorktree)).toBe(
      false,
    );
  });
});
