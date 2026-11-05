import { afterEach, beforeEach, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { checkPermission, isPathWithin } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import type { PermissionRules } from "@/permissions/types";

beforeEach(() => {
  permissionMode.setMode("standard");
});

afterEach(() => {
  permissionMode.reset();
  sessionPermissions.clear();
});

// ============================================================================
// Allowed Directory Boundary Tests
// ============================================================================

const WORKING_DIRECTORY_REASON = "Within working directory";

test("Sibling directories sharing the working directory prefix are not auto-allowed", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = { allow: [], deny: [], ask: [] };

  for (const filePath of [
    "/Users/test/project-notes/secret.md",
    "/Users/test/project2/secret.md",
    "/Users/test/project.bak/secret.md",
  ]) {
    const result = checkPermission(
      "ListDir",
      { path: filePath },
      permissions,
      "/Users/test/project",
    );
    expect(result.reason).not.toBe(WORKING_DIRECTORY_REASON);
    expect(result.decision).not.toBe("allow");
  }
});

test("Nested paths and the working directory itself are auto-allowed", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = { allow: [], deny: [], ask: [] };

  for (const filePath of [
    "/Users/test/project/src/deep/file.ts",
    "/Users/test/project",
  ]) {
    const result = checkPermission(
      "ListDir",
      { path: filePath },
      permissions,
      "/Users/test/project",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe(WORKING_DIRECTORY_REASON);
  }
});

test("Working directory with a trailing separator still matches on boundaries", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = { allow: [], deny: [], ask: [] };

  const inside = checkPermission(
    "ListDir",
    { path: "/Users/test/project/src" },
    permissions,
    "/Users/test/project/",
  );
  expect(inside.decision).toBe("allow");
  expect(inside.reason).toBe(WORKING_DIRECTORY_REASON);

  const sibling = checkPermission(
    "ListDir",
    { path: "/Users/test/project2/src" },
    permissions,
    "/Users/test/project/",
  );
  expect(sibling.reason).not.toBe(WORKING_DIRECTORY_REASON);
});

test("Additional directory siblings sharing a prefix are not auto-allowed", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: ["/Users/test/docs"],
  };

  const sibling = checkPermission(
    "ListDir",
    { path: "/Users/test/docs-private/keys.txt" },
    permissions,
    "/Users/test/project",
  );
  expect(sibling.reason).not.toBe(WORKING_DIRECTORY_REASON);
  expect(sibling.decision).not.toBe("allow");

  const nested = checkPermission(
    "ListDir",
    { path: "/Users/test/docs/api/index.md" },
    permissions,
    "/Users/test/project",
  );
  expect(nested.decision).toBe("allow");
  expect(nested.reason).toBe(WORKING_DIRECTORY_REASON);
});

test("isPathWithin compares POSIX paths by segment and case-sensitively", () => {
  expect(isPathWithin("/x/project", "/x/project", posix)).toBe(true);
  expect(isPathWithin("/x/project/a/b", "/x/project/", posix)).toBe(true);
  expect(isPathWithin("/x/project/..notes", "/x/project", posix)).toBe(true);
  expect(isPathWithin("/x/project-notes", "/x/project", posix)).toBe(false);
  expect(isPathWithin("/x/project2", "/x/project", posix)).toBe(false);
  expect(isPathWithin("/x", "/x/project", posix)).toBe(false);
  expect(isPathWithin("/x/Project/a", "/x/project", posix)).toBe(false);
});

test("isPathWithin handles Windows drives, case and UNC paths", () => {
  expect(isPathWithin("C:\\x\\project\\a.ts", "C:\\x\\project", win32)).toBe(
    true,
  );
  expect(isPathWithin("c:\\X\\PROJECT\\a.ts", "C:\\x\\project\\", win32)).toBe(
    true,
  );
  expect(isPathWithin("C:\\x\\Project", "c:\\x\\project", win32)).toBe(true);
  expect(isPathWithin("D:\\x\\project\\a.ts", "C:\\x\\project", win32)).toBe(
    false,
  );
  expect(isPathWithin("C:\\x\\project2\\a.ts", "C:\\x\\project", win32)).toBe(
    false,
  );
  expect(
    isPathWithin(
      "\\\\server\\share\\repo\\a.ts",
      "\\\\server\\share\\repo",
      win32,
    ),
  ).toBe(true);
  expect(
    isPathWithin(
      "\\\\server\\share\\repo2\\a.ts",
      "\\\\server\\share\\repo",
      win32,
    ),
  ).toBe(false);
});
