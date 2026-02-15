import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isMemoryDirCommand,
  isReadOnlyShellCommand,
} from "../permissions/readOnlyShell";

test("FIX: isReadOnlyShellCommand should not auto-approve reading sensitive files", () => {
  // These used to return true, now should return false
  expect(isReadOnlyShellCommand("cat /etc/passwd")).toBe(false);
  expect(isReadOnlyShellCommand("grep secret /etc/shadow")).toBe(false);
  expect(isReadOnlyShellCommand("head -n 20 ../../../.ssh/id_rsa")).toBe(false);

  // Normal safe commands should still work
  expect(isReadOnlyShellCommand("ls")).toBe(true);
  expect(isReadOnlyShellCommand("cat README.md")).toBe(true);
});

test("FIX: isMemoryDirCommand should not allow command injection via cd bypass", () => {
  const agentId = "agent123";
  const home = homedir();
  const memoryDir = resolve(home, ".letta", "agents", agentId, "memory");

  // This command starts with cd to memory dir, then tries to delete root
  const dangerousCommand = `cd ${memoryDir} && rm -rf /`;

  expect(isMemoryDirCommand(dangerousCommand, agentId)).toBe(false);

  // Safe commands in memory dir should still work
  expect(isMemoryDirCommand(`cd ${memoryDir} && ls`, agentId)).toBe(true);
  expect(isMemoryDirCommand(`cd ${memoryDir} && git status`, agentId)).toBe(
    true,
  );
});
