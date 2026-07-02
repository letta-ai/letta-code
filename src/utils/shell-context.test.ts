import { describe, expect, test } from "bun:test";
import { detectShellContext } from "@/utils/shell-context";

describe("shell context detection", () => {
  test("detects PowerShell on windows env", () => {
    const shell = detectShellContext(
      {
        PSModulePath: "C:\\Users\\caren\\Documents\\PowerShell\\Modules",
      } as NodeJS.ProcessEnv,
      "win32",
    );

    expect(shell.family).toBe("powershell");
    expect(shell.displayName).toContain("PowerShell");
  });

  test("detects cmd on windows env", () => {
    const shell = detectShellContext(
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" } as NodeJS.ProcessEnv,
      "win32",
    );

    expect(shell.family).toBe("cmd");
    expect(shell.displayName).toContain("Command Prompt");
  });

  test("detects bash from SHELL on non-windows", () => {
    const shell = detectShellContext(
      { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      "linux",
    );

    expect(shell.family).toBe("bash");
    expect(shell.displayName).toBe("/bin/zsh");
  });
});
