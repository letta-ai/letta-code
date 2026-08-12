import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildNonInteractiveGitEnv,
  formatGitFailure,
  runGit,
} from "@/tools/impl/worktree-git";

async function installHangingGit(
  tempDirs: string[],
  originalPath: string | undefined,
): Promise<string> {
  const binDir = await mkdtemp(path.join(tmpdir(), "letta-worktree-git-test-"));
  tempDirs.push(binDir);
  const fakeGit = path.join(binDir, "git");
  const descendantScript = "setInterval(() => {}, 1000);";
  const gitScript = [
    "#!/usr/bin/env node",
    'const { spawn } = require("node:child_process");',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
    'process.stdout.write("descendant:" + descendant.pid + "\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await writeFile(fakeGit, gitScript);
  await chmod(fakeGit, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return binDir;
}

function isProcessStillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(")");
    const state =
      endCommand === -1 ? "" : stat.slice(endCommand + 2, endCommand + 3);
    // kill(pid, 0) still succeeds after exit while Linux waits to reap a zombie.
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function expectGitDescendantExited(failure: string): Promise<void> {
  const descendantPid = Number(failure.match(/descendant:(\d+)/)?.[1]);
  expect(descendantPid).toBeGreaterThan(0);
  const deadline = Date.now() + 1000;
  while (isProcessStillRunning(descendantPid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(isProcessStillRunning(descendantPid)).toBe(false);
}

describe("worktree Git runner", () => {
  const originalPath = process.env.PATH;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("disables Git, credential-manager, askpass, and SSH prompts", () => {
    const env = buildNonInteractiveGitEnv({
      PATH: "/usr/bin",
      GIT_SSH_COMMAND: "ssh -F custom.conf",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(env.GIT_SSH_COMMAND).toBe("ssh -F custom.conf -o BatchMode=yes");
    expect(buildNonInteractiveGitEnv({}).GIT_SSH_COMMAND).toBe(
      "ssh -o BatchMode=yes",
    );
  });

  test.skipIf(process.platform === "win32")(
    "kills Git descendants when an internal command times out",
    async () => {
      const binDir = await installHangingGit(tempDirs, originalPath);

      const startedAt = Date.now();
      let failure = "";
      try {
        await runGit(["fetch"], binDir, { timeoutMs: 500 });
      } catch (error) {
        failure = formatGitFailure(error);
      }

      expect(failure).toContain("Timed out running git fetch");
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await expectGitDescendantExited(failure);
    },
  );

  test.skipIf(process.platform === "win32")(
    "kills Git descendants when the worktree tool is interrupted",
    async () => {
      const binDir = await installHangingGit(tempDirs, originalPath);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 500);
      const startedAt = Date.now();
      let failure = "";
      try {
        await runGit(["fetch"], binDir, {
          signal: controller.signal,
          timeoutMs: 10_000,
        });
      } catch (error) {
        failure = formatGitFailure(error);
      } finally {
        clearTimeout(abortTimer);
      }

      expect(failure).toContain(
        "Failed to run git fetch: The operation was aborted",
      );
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await expectGitDescendantExited(failure);
    },
  );
});
