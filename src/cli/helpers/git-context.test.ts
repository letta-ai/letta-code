import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getGitContextAsync } from "./git-context";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("loads device Git context asynchronously", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "letta-git-context-"));
  tempDirectories.push(cwd);
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd,
  });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "Initial"], {
    cwd,
  });
  await execFileAsync("git", ["branch", "feature"], { cwd });

  const contextPromise = getGitContextAsync(cwd);
  expect(contextPromise).toBeInstanceOf(Promise);

  expect(await contextPromise).toEqual({
    branch: "main",
    recent_branches: ["feature"],
  });
});
