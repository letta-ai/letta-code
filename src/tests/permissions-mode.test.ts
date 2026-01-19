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
  // Reason now includes detailed guidance (planFilePath not set in test, so shows error fallback)
  expect(result.reason).toContain("Plan mode is active");
});

test("plan mode - denies non-read-only Bash", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "npm install" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows read-only Bash commands", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  // ls should be allowed
  const lsResult = checkPermission(
    "Bash",
    { command: "ls -la" },
    permissions,
    "/Users/test/project",
  );
  expect(lsResult.decision).toBe("allow");
  expect(lsResult.matchedRule).toBe("plan mode");

  // git status should be allowed
  const gitStatusResult = checkPermission(
    "Bash",
    { command: "git status" },
    permissions,
    "/Users/test/project",
  );
  expect(gitStatusResult.decision).toBe("allow");

  // git log should be allowed
  const gitLogResult = checkPermission(
    "Bash",
    { command: "git log --oneline -10" },
    permissions,
    "/Users/test/project",
  );
  expect(gitLogResult.decision).toBe("allow");

  // git diff should be allowed
  const gitDiffResult = checkPermission(
    "Bash",
    { command: "git diff HEAD~1" },
    permissions,
    "/Users/test/project",
  );
  expect(gitDiffResult.decision).toBe("allow");

  // cd && git should be allowed (common CLI pattern)
  const cdGitResult = checkPermission(
    "Bash",
    { command: "cd /some/path && git status" },
    permissions,
    "/Users/test/project",
  );
  expect(cdGitResult.decision).toBe("allow");

  // cd && git show should be allowed
  const cdGitShowResult = checkPermission(
    "Bash",
    { command: "cd /some/path && git show abc123" },
    permissions,
    "/Users/test/project",
  );
  expect(cdGitShowResult.decision).toBe("allow");

  // chained safe commands with ; should be allowed
  const chainedResult = checkPermission(
    "Bash",
    { command: "ls; pwd; git status" },
    permissions,
    "/Users/test/project",
  );
  expect(chainedResult.decision).toBe("allow");

  // cd && dangerous command should still be denied
  const cdDangerousResult = checkPermission(
    "Bash",
    { command: "cd /some/path && npm install" },
    permissions,
    "/Users/test/project",
  );
  expect(cdDangerousResult.decision).toBe("deny");
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

  // Use a non-read-only command to test precedence
  const result = checkPermission(
    "Bash",
    { command: "npm install" },
    permissions,
    "/Users/test/project",
  );

  // Permission mode denies take precedence over CLI allowedTools
  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("Plan mode is active");

  // Clean up
  cliPermissions.clear();
});
