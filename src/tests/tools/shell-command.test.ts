import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell_command } from "../../tools/impl/ShellCommand.js";

test("shell_command executes basic echo", async () => {
  const result = await shell_command({ command: "echo shell-basic" });
  expect(result.output).toContain("shell-basic");
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
