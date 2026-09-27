import { describe, expect, test } from "bun:test";
import { assertSafeWindowsCommand } from "@/tools/impl/windows-command-safety";

const WINDOWS_OPTIONS = {
  platform: "win32" as const,
  cwd: "C:\\Users\\amelia\\project",
  homeDirectory: "C:\\Users\\amelia",
  env: {
    USERPROFILE: "C:\\Users\\amelia",
    SYSTEMDRIVE: "C:",
  },
};

describe("Windows cmd removal guard", () => {
  test.each([
    "cmd /c rd /s /q C:\\",
    "cmd.exe /d /c rmdir /s /q C:\\Users",
    'cmd /c "del /q C:\\Windows\\*"',
    'cmd /c "del /q C:\\Users\\*.*"',
    "cmd /c erase /q %USERPROFILE%",
    'cmd /c rd /s /q "C:\\Users\\amelia"',
    'cmd /c rd /s /q "C:\\$name"',
    '& "C:\\Windows\\System32\\cmd.exe" /c rd /s /q C:\\Users',
    'pwsh -Command "cmd /c rd /s /q C:\\Users"',
  ])("denies protected target in %s", (command) => {
    expect(() => assertSafeWindowsCommand(command, WINDOWS_OPTIONS)).toThrow(
      "protected Windows path",
    );
  });

  test.each([
    "cmd /c rd /s /q dist",
    "cmd /c rmdir /s /q C:\\Users\\amelia\\project\\build",
    "cmd /c del /q dist\\*",
    "cmd /c echo C:\\Users",
    "Remove-Item -Recurse C:\\Users",
  ])("allows non-system cmd target in %s", (command) => {
    expect(() =>
      assertSafeWindowsCommand(command, WINDOWS_OPTIONS),
    ).not.toThrow();
  });

  test("does not apply outside Windows", () => {
    expect(() =>
      assertSafeWindowsCommand("cmd /c rd /s /q C:\\", {
        ...WINDOWS_OPTIONS,
        platform: "linux",
      }),
    ).not.toThrow();
  });
});
