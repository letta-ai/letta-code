import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";

beforeEach(() => {
  permissionMode.setMode("standard");
});

afterEach(() => {
  permissionMode.reset();
});

test("Edit inside the agent's own memory checkout is auto-allowed", () => {
  const memoryDir = getScopedMemoryFilesystemRoot("agent-memory-edit-test");
  for (const tool of ["Edit", "Write"]) {
    const result = checkPermission(
      tool,
      { file_path: `${memoryDir}/system/user.md` },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
      undefined,
      "agent-memory-edit-test",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Agent memory directory operation");
  }
});

test("Edit outside the memory checkout still asks", () => {
  const result = checkPermission(
    "Edit",
    { file_path: "/Users/test/other/notes.md" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
    undefined,
    "agent-memory-edit-test",
  );
  expect(result.decision).toBe("ask");
});

test("ApplyPatch is auto-allowed only when every file it touches is in the memory checkout", () => {
  const memoryDir = getScopedMemoryFilesystemRoot("agent-memory-edit-test");
  const check = (input: string) =>
    checkPermission(
      "ApplyPatch",
      { input },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
      undefined,
      "agent-memory-edit-test",
    );
  expect(
    check(
      `*** Begin Patch\n*** Update File: ${memoryDir}/system/user.md\n*** Add File: ${memoryDir}/notes/new.md\n*** End Patch`,
    ).decision,
  ).toBe("allow");
  expect(
    check(
      `*** Begin Patch\n*** Update File: ${memoryDir}/system/user.md\n*** Update File: /Users/test/project/src/app.ts\n*** End Patch`,
    ).decision,
  ).toBe("ask");
  expect(check("*** Begin Patch\n*** End Patch").decision).toBe("ask");
});

test.skipIf(process.platform === "win32")(
  "an edit through a symlink out of the memory checkout is not auto-allowed",
  () => {
    const home = mkdtempSync(join(tmpdir(), "memory-edit-symlink-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const memoryDir = getScopedMemoryFilesystemRoot("agent-memory-link-test");
      mkdirSync(memoryDir, { recursive: true });
      mkdirSync(join(home, "elsewhere"));
      symlinkSync(join(home, "elsewhere"), join(memoryDir, "escape"));
      const check = (file_path: string) =>
        checkPermission(
          "Write",
          { file_path },
          { allow: [], deny: [], ask: [] },
          "/Users/test/project",
          undefined,
          "agent-memory-link-test",
        ).decision;
      expect(check(join(memoryDir, "escape", "notes.md"))).toBe("ask");
      expect(check(join(memoryDir, "notes.md"))).toBe("allow");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("strict mode does not auto-allow memory checkout edits", () => {
  permissionMode.setMode("strict");
  const memoryDir = getScopedMemoryFilesystemRoot("agent-memory-edit-test");
  const result = checkPermission(
    "Edit",
    { file_path: `${memoryDir}/system/user.md` },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
    undefined,
    "agent-memory-edit-test",
  );
  expect(result.decision).toBe("ask");
});
