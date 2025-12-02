import { expect, test } from "bun:test";
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
