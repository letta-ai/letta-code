import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isMemoryDirCommand,
  isReadOnlyShellCommand,
} from "@/permissions/read-only-shell";

test("FIX: isReadOnlyShellCommand should not auto-approve reading sensitive files", () => {
  expect(isReadOnlyShellCommand("cat /etc/passwd")).toBe(false);
  expect(isReadOnlyShellCommand("grep secret /etc/shadow")).toBe(false);
  expect(isReadOnlyShellCommand("head -n 20 ../../../.ssh/id_rsa")).toBe(false);
  expect(
    isReadOnlyShellCommand("cat C:\\Windows\\System32\\drivers\\etc\\hosts"),
  ).toBe(false);

  expect(isReadOnlyShellCommand("ls")).toBe(true);
  expect(isReadOnlyShellCommand("cat README.md")).toBe(true);

  expect(isReadOnlyShellCommand("cd / && cat etc/passwd")).toBe(false);
  expect(isReadOnlyShellCommand("cd C:\\ && type Windows\\win.ini")).toBe(
    false,
  );
});

test("FIX: isMemoryDirCommand should not allow command injection via cd bypass", () => {
  const agentId = "agent123";
  const home = homedir();
  const memoryDir = resolve(home, ".letta", "agents", agentId, "memory");

  const dangerousCommand = `cd ${memoryDir} && rm -rf /`;
  const dangerousWindowsCommand = `cd ${memoryDir} && type C:\\Windows\\win.ini`;

  expect(isMemoryDirCommand(dangerousCommand, agentId)).toBe(false);
  expect(isMemoryDirCommand(dangerousWindowsCommand, agentId)).toBe(false);

  expect(isMemoryDirCommand(`cd ${memoryDir} && ls`, agentId)).toBe(true);
  expect(isMemoryDirCommand(`cd ${memoryDir} && git status`, agentId)).toBe(
    true,
  );
});
