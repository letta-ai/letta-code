import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shell_command } from "../../tools/impl/ShellCommand.js";
import { LIMITS } from "../../tools/impl/truncation.js";

test("shell_command executes basic echo", async () => {
  const result = await shell_command({ command: "echo shell-basic" });
  expect(result.output).toContain("shell-basic");
});

test("shell_command preserves stdout and stderr arrays when output is not truncated", async () => {
  const result = await shell_command({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('stdout'); process.stderr.write('stderr');")}`,
  });

  expect(result.output).toContain("stdout");
  expect(result.output).toContain("stderr");
  expect(result.stdout).toEqual(["stdout"]);
  expect(result.stderr).toEqual(["stderr"]);
});

test("shell_command falls back when preferred shell is missing", async () => {
  const marker = "shell-fallback";
  if (process.platform === "win32") {
    const originalUpper = process.env.COMSPEC;
    const originalLower = process.env.ComSpec;
    process.env.COMSPEC = "C:/missing-shell.exe";
    process.env.ComSpec = "C:/missing-shell.exe";
    try {
      const result = await shell_command({ command: `echo ${marker}` });
      expect(result.output).toContain(marker);
    } finally {
      if (originalUpper === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = originalUpper;
      if (originalLower === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalLower;
    }
  } else {
    const original = process.env.SHELL;
    process.env.SHELL = "/nonexistent-shell";
    try {
      const result = await shell_command({ command: `echo ${marker}` });
      expect(result.output).toContain(marker);
    } finally {
      if (original === undefined) delete process.env.SHELL;
      else process.env.SHELL = original;
    }
  }
});

test("shell_command truncates oversized output with overflow-file notice", async () => {
  const tempId = randomUUID();
  const workdir = join(homedir(), ".letta", "tmp-shell-command", tempId);
  const originalOverflow = process.env.LETTA_TOOL_OVERFLOW_TO_FILE;
  let overflowPath: string | undefined;

  mkdirSync(workdir, { recursive: true });
  process.env.LETTA_TOOL_OVERFLOW_TO_FILE = "true";

  try {
    const script = `process.stdout.write("x".repeat(${LIMITS.BASH_OUTPUT_CHARS + 500}))`;
    const result = await shell_command({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      workdir,
    });

    expect(result.output).toContain("[Output truncated:");
    expect(result.output).toContain("[Full output written to:");
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();

    const overflowMatch = result.output.match(
      /\[Full output written to: (.+)\]/,
    );
    overflowPath = overflowMatch?.[1]?.trim();
    expect(overflowPath).toBeDefined();
    if (!overflowPath) {
      throw new Error("Expected overflow file pointer in shell_command output");
    }

    expect(existsSync(overflowPath)).toBe(true);
    expect(readFileSync(overflowPath, "utf8").length).toBe(
      LIMITS.BASH_OUTPUT_CHARS + 500,
    );
  } finally {
    if (originalOverflow === undefined) {
      delete process.env.LETTA_TOOL_OVERFLOW_TO_FILE;
    } else {
      process.env.LETTA_TOOL_OVERFLOW_TO_FILE = originalOverflow;
    }

    if (overflowPath) {
      rmSync(dirname(overflowPath), { recursive: true, force: true });
    }

    rmSync(workdir, { recursive: true, force: true });
  }
});

test("shell_command uses agent identity for memory-dir git commits", async () => {
  const agentId = `agent-test-${randomUUID()}`;
  const memoryRoot = join(homedir(), ".letta", "agents", agentId);
  const memoryDir = join(memoryRoot, "memory");
  const originalAgentId = process.env.AGENT_ID;
  const originalLettaAgentId = process.env.LETTA_AGENT_ID;
  const originalAgentName = process.env.AGENT_NAME;
  mkdirSync(memoryDir, { recursive: true });
  process.env.AGENT_ID = agentId;
  process.env.LETTA_AGENT_ID = agentId;
  process.env.AGENT_NAME = "Shell Command Test Agent";
  try {
    await shell_command({ command: "git init", workdir: memoryDir });
    await shell_command({
      command: "git config user.name setup",
      workdir: memoryDir,
    });
    await shell_command({
      command: "git config user.email setup@example.com",
      workdir: memoryDir,
    });

    const repoStatus = await shell_command({
      command: "git rev-parse --is-inside-work-tree",
      workdir: memoryDir,
    });
    expect(repoStatus.output.trim()).toContain("true");

    writeFileSync(join(memoryDir, ".gitkeep"), "", "utf8");
    await shell_command({ command: "git add .gitkeep", workdir: memoryDir });
    await shell_command({
      command: 'git commit -m "initial setup commit"',
      workdir: memoryDir,
    });

    writeFileSync(join(memoryDir, "test.md"), "hello\n", "utf8");
    await shell_command({ command: "git add test.md", workdir: memoryDir });
    await shell_command({
      command: 'git commit -m "test memory commit"',
      workdir: memoryDir,
    });

    const logResult = await shell_command({
      command: 'git log -1 --format="%s|%ae|%ce"',
      workdir: memoryDir,
    });

    expect(logResult.output.trim()).toBe(
      `test memory commit|${agentId}@letta.com|${agentId}@letta.com`,
    );
  } finally {
    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;

    if (originalLettaAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalLettaAgentId;

    if (originalAgentName === undefined) delete process.env.AGENT_NAME;
    else process.env.AGENT_NAME = originalAgentName;

    rmSync(memoryRoot, { recursive: true, force: true });
  }
});
