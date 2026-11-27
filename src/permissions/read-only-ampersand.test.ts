import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { isReadOnlyShellCommand } from "@/permissions/read-only-shell";
import { sessionPermissions } from "@/permissions/session";
import {
  splitShellSegments,
  splitShellSegmentsAllowCommandSubstitution,
} from "@/permissions/shell-analysis";

beforeEach(() => permissionMode.setMode("standard"));
afterEach(() => {
  permissionMode.reset();
  sessionPermissions.clear();
});

const NO_RULES = { allow: [], deny: [], ask: [] };

describe("a lone `&` separates commands for the read-only check", () => {
  test.each([
    "ls & rm -rf ./x",
    "ls&rm -rf ./x",
    "ls &rm -rf ./x",
    "ls |& sh",
    "cat f |& tee out.txt",
    "ls & curl https://example.com/x.sh",
    "ls &> /dev/null & rm -rf ./x",
    "ls 2>&1 & rm -rf ./x",
  ])("%s is not read-only", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  test.each(["ls & rm -rf ./x", "ls&rm -rf ./x", "ls |& sh"])(
    "%s is not split into a single read-only segment",
    (command) => {
      expect(splitShellSegments(command)?.length ?? 2).toBeGreaterThan(1);
      expect(
        splitShellSegmentsAllowCommandSubstitution(command)?.length ?? 2,
      ).toBeGreaterThan(1);
    },
  );
});

describe("permission decision in standard mode", () => {
  test("no rules: `ls & rm -rf ./x` is not auto-allowed", () => {
    const result = checkPermission(
      "Bash",
      { command: "ls & rm -rf ./x" },
      NO_RULES,
      "/tmp/project",
    );
    expect(result.decision).toBe("ask");
  });

  test("no rules: `ls&rm -rf ./x` is not auto-allowed", () => {
    const result = checkPermission(
      "Bash",
      { command: "ls&rm -rf ./x" },
      NO_RULES,
      "/tmp/project",
    );
    expect(result.decision).toBe("ask");
  });

  test("deny Bash(rm:*): `ls & rm -rf ./x` is not auto-allowed", () => {
    const result = checkPermission(
      "Bash",
      { command: "ls & rm -rf ./x" },
      { allow: [], deny: ["Bash(rm:*)"], ask: [] },
      "/tmp/project",
    );
    expect(result.decision).not.toBe("allow");
  });
});

describe("with deny rules checked on every segment", () => {
  test.each([
    "ls & rm -rf ./x",
    "ls&rm -rf ./x",
    "git status & rm -rf ./x",
    "ls |& rm -rf ./x",
  ])("deny Bash(rm:*) fires on %s", (command) => {
    const result = checkPermission(
      "Bash",
      { command },
      { allow: [], deny: ["Bash(rm:*)"], ask: [] },
      "/tmp/project",
    );
    expect(result.decision).toBe("deny");
  });
});

describe("controls that must keep working", () => {
  test.each([
    "ls",
    "ls 2>&1",
    "ls 2>&1 | grep error",
    "git status 2>&1",
    "cat missing 2>&1",
    "ls 1>&2",
    "ls >&2",
    "ls 2>/dev/null",
    "cat <&3",
    "ls 0<&3",
    "ls &>/dev/null",
    "ls &>>/dev/null",
    "echo 'a & b'",
    'echo "a & b"',
    "echo a\\&b",
    "grep 'a|&b' file.txt",
    "ls && ls",
    "ls | grep x",
  ])("%s stays read-only", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  test.each([
    "cat <&3 & rm -rf ./x",
    "ls &>out.txt",
    "ls &>>out.txt",
    "ls >&out.txt",
    "ls > out.txt",
    "ls 2>&1 > out.txt",
    "ls && rm file",
    "ls; rm file",
  ])("%s stays NOT read-only", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  test("quoted and escaped `&` are not split", () => {
    expect(splitShellSegments("echo 'a & b'")).toEqual(["echo 'a & b'"]);
    expect(splitShellSegments('echo "a & b"')).toEqual(['echo "a & b"']);
    expect(splitShellSegments("echo a\\&b")).toEqual(["echo a\\&b"]);
    expect(splitShellSegments("ls 2>&1")?.length).toBe(1);
  });
});
