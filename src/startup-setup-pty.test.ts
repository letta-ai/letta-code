import { describe, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const projectRoot = process.cwd();
let builtCliPath: string | null = null;

function ensureBuiltCli(): string {
  if (builtCliPath) {
    return builtCliPath;
  }

  const cliPath = join(projectRoot, "letta.js");
  const result = spawnSync("bun", ["run", "build"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build letta.js\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  builtCliPath = cliPath;
  return cliPath;
}

const ptyTest = process.platform === "win32" ? test.skip : test;

function runPtyScenario(scenario: string, failureLabel: string): void {
  const runnerPath = join(
    projectRoot,
    "src/test-utils/startup-setup-pty-runner.cjs",
  );
  const result = spawnSync(
    "node",
    [runnerPath, ensureBuiltCli(), projectRoot, scenario],
    {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 30000,
    },
  );

  if (result.status !== 0 || result.signal !== null || result.stderr) {
    throw new Error(
      [
        `${failureLabel} failed with status ${result.status} signal ${result.signal}`,
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
}

describe("startup setup PTY", () => {
  ptyTest(
    "setup menu keeps raw keyboard input after terminal preflight",
    () => {
      runPtyScenario("setup-menu-raw-input", "PTY setup runner");
    },
    { timeout: 35000 },
  );

  ptyTest(
    "agent-limit default creation falls back to an existing agent and waits for acknowledgement",
    () => {
      runPtyScenario("agent-limit-fallback", "PTY fallback runner");
    },
    { timeout: 35000 },
  );

  ptyTest(
    "non-quota default creation failure does not fallback to existing agents",
    () => {
      runPtyScenario("non-quota-create-failure", "PTY non-quota runner");
    },
    { timeout: 35000 },
  );

  ptyTest(
    "agent-limit default creation still fails when no existing agents are available",
    () => {
      runPtyScenario("agent-limit-empty-list", "PTY empty-list runner");
    },
    { timeout: 35000 },
  );

  ptyTest(
    "agent-limit default creation still fails when existing agents cannot be listed",
    () => {
      runPtyScenario("agent-limit-list-failure", "PTY list-failure runner");
    },
    { timeout: 35000 },
  );
});
