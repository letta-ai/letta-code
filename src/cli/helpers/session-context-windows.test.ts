import { describe, expect, test } from "bun:test";

import { buildWindowsShellNotes } from "@/cli/helpers/session-context";

describe("Session Context Windows Notes", () => {
  test("Windows shell notes contain heredoc warning", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "powershell",
      displayName: "PowerShell 7",
    });

    expect(windowsShellNotes).toContain("HEREDOC");
    expect(windowsShellNotes).toContain("does NOT work on Windows");
  });

  test("Windows shell notes mention the detected shell", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "powershell",
      displayName: "PowerShell 7",
    });

    expect(windowsShellNotes).toContain("Detected shell: PowerShell 7");
    expect(windowsShellNotes).toContain("PowerShell-safe commands");
  });

  test("Windows shell notes provide alternative for multiline strings", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "cmd",
      displayName: "Command Prompt",
    });

    expect(windowsShellNotes).toContain("simple quoted strings");
  });

  test("Windows shell notes warn against redirecting native stderr", () => {
    for (const family of ["powershell", "cmd", "bash", "unknown"] as const) {
      const windowsShellNotes = buildWindowsShellNotes({
        family,
        displayName: "Windows shell",
      });

      expect(windowsShellNotes).toContain("Do NOT redirect native stderr");
      expect(windowsShellNotes).toContain("2>&1");
      expect(windowsShellNotes).toContain("2>$null");
      expect(windowsShellNotes).toContain("captures stderr separately");
      expect(windowsShellNotes).not.toContain("GIT_REDIRECT_STDERR");
      expect(windowsShellNotes).not.toContain("using your shell's syntax");
    }
  });
});
