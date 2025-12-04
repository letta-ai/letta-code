import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "../permissions/checker";
import { permissionMode } from "../permissions/mode";
import type { PermissionRules } from "../permissions/types";

// Clean up after each test
afterEach(() => {
  permissionMode.reset();
});

// ============================================================================
// Permission Mode: default
// ============================================================================

test("default mode - no overrides", () => {
  permissionMode.setMode("default");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "curl http://example.com" }, // Use non-read-only command
    permissions,
    "/Users/test/project",
  );

  // Should fall back to tool default (ask for Bash)
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

// ============================================================================
// Permission Mode: bypassPermissions
// ============================================================================

test("bypassPermissions mode - allows all tools", () => {
  permissionMode.setMode("bypassPermissions");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const bashResult = checkPermission(
    "Bash",
    { command: "rm -rf /" },
    permissions,
    "/Users/test/project",
  );
  expect(bashResult.decision).toBe("allow");
  expect(bashResult.reason).toBe("Permission mode: bypassPermissions");

  const writeResult = checkPermission(
    "Write",
    { file_path: "/etc/passwd" },
    permissions,
    "/Users/test/project",
  );
  expect(writeResult.decision).toBe("allow");
});

test("bypassPermissions mode - does NOT override deny rules", () => {
  permissionMode.setMode("bypassPermissions");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Bash(rm -rf:*)"],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "rm -rf /" },
    permissions,
    "/Users/test/project",
  );

  // Deny rules take precedence even in bypassPermissions mode
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
});

// ============================================================================
// Permission Mode: acceptEdits
// ============================================================================

test("acceptEdits mode - allows Write", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
  expect(result.reason).toBe("Permission mode: acceptEdits");
});

test("acceptEdits mode - allows Edit", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Edit",
    { file_path: "/tmp/test.txt", old_string: "old", new_string: "new" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
});

test("acceptEdits mode - allows NotebookEdit", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "NotebookEdit",
    { notebook_path: "/tmp/test.ipynb", new_source: "code" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
});

test("acceptEdits mode - does NOT allow Bash", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "curl http://example.com" }, // Use non-read-only command
    permissions,
    "/Users/test/project",
  );

  // Bash is not an edit tool, should fall back to default
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

// ============================================================================
// Permission Mode: plan
// ============================================================================

test("plan mode - allows Read", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows Glob", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Glob",
    { pattern: "**/*.ts" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows Grep", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Grep",
    { pattern: "import", path: "/tmp" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows TodoWrite", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "TodoWrite",
    { todos: [] },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - denies Write", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
  expect(result.reason).toBe("Permission mode: plan");
});

test("plan mode - denies Bash", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - denies WebFetch", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "WebFetch",
    { url: "https://example.com" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
});

// ============================================================================
// Precedence Tests
// ============================================================================

test("Deny rules override permission mode", () => {
  permissionMode.setMode("bypassPermissions");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Write(**)"],
    ask: [],
  };

  const result = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );

  // Deny rule takes precedence over bypassPermissions
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
});

test("Permission mode takes precedence over CLI allowedTools", () => {
  const { cliPermissions } = require("../permissions/cli");
  cliPermissions.setAllowedTools("Bash");

  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "ls" },
    permissions,
    "/Users/test/project",
  );

  // Permission mode denies take precedence over CLI allowedTools
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Permission mode: plan");

  // Clean up
  cliPermissions.clear();
});
