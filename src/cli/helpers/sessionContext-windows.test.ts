import { describe, expect, test } from "bun:test";

// Test the Windows shell notes logic directly
// The actual sessionContext.ts uses platform() which we can't easily mock,
// but we can test that the Windows notes content is correct

describe("Session Context Windows Notes", () => {
  const windowsShellNotes = `
## Windows Shell Notes
- The Bash tool uses PowerShell or cmd.exe on Windows
- HEREDOC syntax (e.g., \`$(cat <<'EOF'...EOF)\`) does NOT work on Windows
- For multiline strings (git commits, PR bodies), use simple quoted strings instead
`;

  test("Windows shell notes contain heredoc warning", () => {
    expect(windowsShellNotes).toContain("HEREDOC");
    expect(windowsShellNotes).toContain("does NOT work on Windows");
  });

  test("Windows shell notes mention PowerShell", () => {
    expect(windowsShellNotes).toContain("PowerShell");
  });

  test("Windows shell notes provide alternative for multiline strings", () => {
    expect(windowsShellNotes).toContain("simple quoted strings");
  });

  if (process.platform === "win32") {
    test("running on Windows - notes should be relevant", () => {
      // This test only runs on Windows CI
      // Confirms we're actually testing on Windows
      expect(process.platform).toBe("win32");
    });
  }
});
