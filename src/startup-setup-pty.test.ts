import { describe, test } from "bun:test";
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

function runPtyRunner(filename: string, ...args: string[]): void {
  const runnerPath = join(projectRoot, `src/test-utils/${filename}`);
  const result = spawnSync(
    "node",
    [runnerPath, ensureBuiltCli(), projectRoot, ...args],
    {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
    },
  );

  if (result.status !== 0 || result.signal !== null || result.stderr) {
    throw new Error(
      [
        `${filename} failed with status ${result.status} signal ${result.signal}`,
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
}

describe("startup PTY", () => {
  ptyTest(
    "setup menu keeps raw keyboard input after terminal preflight",
    () => runPtyRunner("startup-setup-pty-runner.cjs"),
    { timeout: 35000 },
  );

  for (const runtime of ["bun", "node"]) {
    ptyTest(
      `${runtime} secrets rejection stays nonfatal before later startup synchronization`,
      () => runPtyRunner("startup-secrets-pty-runner.cjs", runtime),
      { timeout: 35000 },
    );
  }
});
