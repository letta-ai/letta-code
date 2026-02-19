import { expect, test } from "bun:test";
import { checkPermission } from "../permissions/checker";
import { sessionPermissions } from "../permissions/session";
import type { PermissionRules } from "../permissions/types";

// ============================================================================
// Working Directory Tests
// ============================================================================

test("Read within working directory is auto-allowed", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const result = checkPermission(
    "Read",
    { file_path: "src/test.ts" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Within working directory");
});

test("Read outside working directory requires permission", () => {
  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/other/file.ts" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  // Default for Read is allow, but not within working directory
  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("Glob within working directory is auto-allowed", () => {
  const result = checkPermission(
    "Glob",
    { path: "/Users/test/project/src" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

// ============================================================================
// Long Command Caching Tests
// ============================================================================

test("Long bash commands should use wildcard patterns, not exact match", () => {
  // This is the bug: when you approve a long command like
  // "cd /path && git diff file.ts | head -100"
  // it should also match
  // "cd /path && git diff file.ts | tail -30"
  // But currently it saves an exact match instead of a wildcard

  const longCommand1 =
    "cd /Users/test/project && git diff src/file.ts | head -100";
  const longCommand2 =
    "cd /Users/test/project && git diff src/file.ts | tail -30";

  // After approving the first command with a wildcard pattern
  const permissions: PermissionRules = {
    allow: ["Bash(cd /Users/test/project && git diff:*)"],
    deny: [],
    ask: [],
  };

  // Both should match
  const result1 = checkPermission(
    "Bash",
    { command: longCommand1 },
    permissions,
    "/Users/test/project",
  );
  expect(result1.decision).toBe("allow");

  const result2 = checkPermission(
    "Bash",
    { command: longCommand2 },
    permissions,
    "/Users/test/project",
  );
  expect(result2.decision).toBe("allow");
});

test("Grep within working directory is auto-allowed", () => {
  const result = checkPermission(
    "Grep",
    { path: "/Users/test/project" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

// ============================================================================
// Additional Directories Tests
// ============================================================================

test("Read in additional directory is auto-allowed", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: ["../docs"],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/docs/api.md" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Within working directory");
});

test("Multiple additional directories", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: ["../docs", "~/shared"],
  };

  const result1 = checkPermission(
    "Read",
    { file_path: "/Users/test/docs/file.md" },
    permissions,
    "/Users/test/project",
  );
  expect(result1.decision).toBe("allow");

  const homedir = require("node:os").homedir();
  const result2 = checkPermission(
    "Read",
    { file_path: `${homedir}/shared/file.txt` },
    permissions,
    "/Users/test/project",
  );
  expect(result2.decision).toBe("allow");
});

// ============================================================================
// Deny Rule Precedence Tests
// ============================================================================

test("Deny rule overrides working directory auto-allow", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(.env)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: ".env" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("Read(.env)");
});

test("Deny pattern blocks multiple files", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(.env.*)"],
    ask: [],
  };

  const result1 = checkPermission(
    "Read",
    { file_path: ".env.local" },
    permissions,
    "/Users/test/project",
  );
  expect(result1.decision).toBe("deny");

  const result2 = checkPermission(
    "Read",
    { file_path: ".env.production" },
    permissions,
    "/Users/test/project",
  );
  expect(result2.decision).toBe("deny");
});

test("Deny directory blocks all files within", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(secrets/**)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "secrets/api-key.txt" },
    permissions,
    "/Users/test/project",
  );
  expect(result.decision).toBe("deny");
});

// ============================================================================
// Allow Rule Tests
// ============================================================================

test("Allow rule for file outside working directory", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = {
    allow: ["Read(/Users/test/docs/**)"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/docs/api.md" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Read(/Users/test/docs/**)");
});

test("Allow rule for Bash command", () => {
  const permissions: PermissionRules = {
    allow: ["Bash(npm run:*)"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "npm run build" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Bash(npm run:*)");
});

test("Allow exact Bash command", () => {
  const permissions: PermissionRules = {
    allow: ["Bash(npm run lint)"],
    deny: [],
    ask: [],
  };

  const result1 = checkPermission(
    "Bash",
    { command: "npm run lint" },
    permissions,
    "/Users/test/project",
  );
  expect(result1.decision).toBe("allow");

  const result2 = checkPermission(
    "Bash",
    { command: "npm run lint --fix" },
    permissions,
    "/Users/test/project",
  );
  expect(result2.decision).toBe("ask"); // Doesn't match exact
});

test("Issue #969: legacy Windows Edit allow rule matches memory project file", () => {
  const permissions: PermissionRules = {
    allow: [
      "Edit(/C:\\Users\\Aaron\\.letta\\agents\\agent-7dcc\\memory\\system\\project/**)",
    ],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Edit",
    {
      file_path:
        "C:\\Users\\Aaron\\.letta\\agents\\agent-7dcc\\memory\\system\\project\\tech_stack.md",
    },
    permissions,
    "C:\\Users\\Aaron\\repo",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe(
    "Edit(/C:\\Users\\Aaron\\.letta\\agents\\agent-7dcc\\memory\\system\\project/**)",
  );
});

test("Issue #969 guardrail: Windows legacy Edit rule does not over-match sibling subtree", () => {
  const permissions: PermissionRules = {
    allow: [
      "Edit(/C:\\Users\\Aaron\\.letta\\agents\\agent-7dcc\\memory\\system\\project/**)",
    ],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Edit",
    {
      file_path:
        "C:\\Users\\Aaron\\.letta\\agents\\agent-7dcc\\memory\\system\\other\\x.md",
    },
    permissions,
    "C:\\Users\\Aaron\\repo",
  );

  expect(result.decision).toBe("ask");
});

// ============================================================================
// Ask Rule Tests
// ============================================================================

test("Ask rule forces prompt", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: ["Bash(git push:*)"],
  };

  const result = checkPermission(
    "Bash",
    { command: "git push origin main" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.matchedRule).toBe("Bash(git push:*)");
});

test("Ask rule for specific file pattern", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: ["Write(**/*.sql)"],
  };

  const result = checkPermission(
    "Write",
    { file_path: "migrations/001.sql" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
});

// ============================================================================
// Default Behavior Tests
// ============================================================================

test("Read defaults to allow", () => {
  const result = checkPermission(
    "Read",
    { file_path: "/some/external/file.txt" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("Bash defaults to ask", () => {
  const result = checkPermission(
    "Bash",
    { command: "curl http://example.com" }, // Use non-read-only command
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("Write defaults to ask", () => {
  const result = checkPermission(
    "Write",
    { file_path: "new-file.txt" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
});

test("Edit defaults to ask", () => {
  const result = checkPermission(
    "Edit",
    { file_path: "existing-file.txt" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
});

test("TodoWrite defaults to allow", () => {
  const result = checkPermission(
    "TodoWrite",
    { todos: [] },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

// ============================================================================
// Precedence Order Tests
// ============================================================================

test("Deny takes precedence over allow", () => {
  const permissions: PermissionRules = {
    allow: ["Read(secrets/**)"],
    deny: ["Read(secrets/**)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "secrets/key.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
});

test("Deny takes precedence over working directory", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(.env)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: ".env" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
});

test("Allow takes precedence over ask", () => {
  const permissions: PermissionRules = {
    allow: ["Bash(git diff:*)"],
    deny: [],
    ask: ["Bash(git diff:*)"],
  };

  const result = checkPermission(
    "Bash",
    { command: "git diff HEAD" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

test("Ask takes precedence over default", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: ["Read(/etc/**)"],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/etc/hosts" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
});

// ============================================================================
// Session Permission Tests (Integration)
// ============================================================================

test("Session allow rule takes precedence over persisted allow", () => {
  // Add a session rule
  sessionPermissions.clear();
  sessionPermissions.addRule("Bash(git push:*)", "allow");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: ["Bash(git push:*)"], // Would normally ask
  };

  const result = checkPermission(
    "Bash",
    { command: "git push origin main" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toContain("session");

  // Clean up
  sessionPermissions.clear();
});

test("Session rules don't persist after clear", () => {
  sessionPermissions.clear();
  sessionPermissions.addRule("Bash(ls:*)", "allow");

  expect(sessionPermissions.hasRule("Bash(ls:*)", "allow")).toBe(true);

  sessionPermissions.clear();

  expect(sessionPermissions.hasRule("Bash(ls:*)", "allow")).toBe(false);
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

test("Missing file_path parameter", () => {
  const result = checkPermission(
    "Read",
    {}, // No file_path
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  // Should fall back to default
  expect(result.decision).toBe("allow");
});

test("Missing command parameter for Bash", () => {
  const result = checkPermission(
    "Bash",
    {}, // No command
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  // Should fall back to default
  expect(result.decision).toBe("ask");
});

test("Unknown tool defaults to ask", () => {
  const result = checkPermission(
    "UnknownTool",
    {},
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("Empty permissions object", () => {
  const result = checkPermission(
    "Read",
    { file_path: "test.txt" },
    {}, // No arrays defined
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

test("Relative path normalization", () => {
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(./secrets/**)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "secrets/key.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
});

test("Parent directory traversal", () => {
  const result = checkPermission(
    "Read",
    { file_path: "../other-project/file.txt" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  // Outside working directory, uses default
  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("Absolute path handling", () => {
  if (process.platform === "win32") return; // Skip on Windows - Unix paths
  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read(/etc/**)"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/etc/hosts" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
});

test("Tool with alternative path parameter (Glob uses 'path' not 'file_path')", () => {
  const result = checkPermission(
    "Glob",
    { path: "src" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
});

test("Shell alias tools match Bash permission patterns", () => {
  const permissions: PermissionRules = {
    allow: ["Bash(curl:*)"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "run_shell_command",
    { command: "curl -s http://localhost:4321/health" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("Bash(curl:*)");
});

test("Legacy bare WriteFileGemini rule still matches write invocations", () => {
  const permissions: PermissionRules = {
    allow: ["WriteFileGemini"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "WriteFileGemini",
    { file_path: "src/main.ts", content: "console.log('x');" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("WriteFileGemini");
});

test("LETTA_PERMISSIONS_V2=0 preserves legacy alias mismatch behavior", () => {
  const original = process.env.LETTA_PERMISSIONS_V2;
  process.env.LETTA_PERMISSIONS_V2 = "0";

  try {
    const permissions: PermissionRules = {
      allow: ["Bash(curl:*)"],
      deny: [],
      ask: [],
    };

    const result = checkPermission(
      "run_shell_command",
      { command: "curl -s http://localhost:4321/health" },
      permissions,
      "/Users/test/project",
    );

    expect(result.decision).toBe("ask");
  } finally {
    if (original === undefined) {
      delete process.env.LETTA_PERMISSIONS_V2;
    } else {
      process.env.LETTA_PERMISSIONS_V2 = original;
    }
  }
});

test("permission trace is attached for ask decisions when LETTA_PERMISSION_TRACE=1", () => {
  const originalTrace = process.env.LETTA_PERMISSION_TRACE;
  process.env.LETTA_PERMISSION_TRACE = "1";

  try {
    const result = checkPermission(
      "Bash",
      { command: "npm install" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );

    expect(result.decision).toBe("ask");
    expect(result.trace).toBeDefined();
    expect(result.trace?.engine).toBe("v2");
    expect(result.trace?.events.length).toBeGreaterThan(0);
  } finally {
    if (originalTrace === undefined) {
      delete process.env.LETTA_PERMISSION_TRACE;
    } else {
      process.env.LETTA_PERMISSION_TRACE = originalTrace;
    }
  }
});

test("dual eval attaches shadow decision when enabled", () => {
  const originalTrace = process.env.LETTA_PERMISSION_TRACE;
  const originalTraceAll = process.env.LETTA_PERMISSION_TRACE_ALL;
  const originalDual = process.env.LETTA_PERMISSIONS_DUAL_EVAL;
  const originalV2 = process.env.LETTA_PERMISSIONS_V2;
  delete process.env.LETTA_PERMISSIONS_V2;
  process.env.LETTA_PERMISSION_TRACE = "0";
  process.env.LETTA_PERMISSION_TRACE_ALL = "1";
  process.env.LETTA_PERMISSIONS_DUAL_EVAL = "1";

  try {
    const permissions: PermissionRules = {
      allow: ["Bash(curl:*)"],
      deny: [],
      ask: [],
    };

    const result = checkPermission(
      "run_shell_command",
      { command: "curl -s http://localhost:4321/health" },
      permissions,
      "/Users/test/project",
    );

    expect(result.decision).toBe("allow");
    expect(result.trace?.shadow?.engine).toBe("v1");
    expect(result.trace?.shadow?.decision).toBe("ask");
  } finally {
    if (originalTrace === undefined) {
      delete process.env.LETTA_PERMISSION_TRACE;
    } else {
      process.env.LETTA_PERMISSION_TRACE = originalTrace;
    }
    if (originalTraceAll === undefined) {
      delete process.env.LETTA_PERMISSION_TRACE_ALL;
    } else {
      process.env.LETTA_PERMISSION_TRACE_ALL = originalTraceAll;
    }
    if (originalDual === undefined) {
      delete process.env.LETTA_PERMISSIONS_DUAL_EVAL;
    } else {
      process.env.LETTA_PERMISSIONS_DUAL_EVAL = originalDual;
    }
    if (originalV2 === undefined) {
      delete process.env.LETTA_PERMISSIONS_V2;
    } else {
      process.env.LETTA_PERMISSIONS_V2 = originalV2;
    }
  }
});
