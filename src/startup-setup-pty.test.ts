import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();

function ensureBuiltCli(): string {
  const cliPath = join(projectRoot, "letta.js");
  if (existsSync(cliPath)) {
    return cliPath;
  }

  const result = spawnSync("bun", ["run", "build"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build letta.js\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return cliPath;
}

const ptyTest = process.platform === "win32" ? test.skip : test;

describe("startup setup PTY", () => {
  ptyTest(
    "setup menu keeps raw keyboard input after terminal preflight",
    () => {
      const runnerPath = join(
        projectRoot,
        "src/test-utils/startup-setup-pty-runner.cjs",
      );
      const result = spawnSync(
        "node",
        [runnerPath, ensureBuiltCli(), projectRoot],
        {
          cwd: projectRoot,
          encoding: "utf-8",
          timeout: 30000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
    },
    { timeout: 35000 },
  );
});
