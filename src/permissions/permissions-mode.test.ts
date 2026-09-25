import { afterEach, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { checkPermission } from "@/permissions/checker";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";

// Clean up after each test
afterEach(() => {
  permissionMode.reset();
  cliPermissions.clear();
});

// ============================================================================
// Permission Mode: default
// ============================================================================

test("default mode - no overrides", () => {
  permissionMode.setMode("standard");

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

test("default mode - auto-allows memory", () => {
  permissionMode.setMode("standard");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "memory",
    {
      command: "create",
      reason: "seed",
      path: "system/human/profile.md",
      description: "Profile",
      file_text: "hello",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("default mode - auto-allows memory_apply_patch", () => {
  permissionMode.setMode("standard");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "memory_apply_patch",
    {
      reason: "seed",
      input:
        "*** Begin Patch\n*** Add File: system/human/profile.md\n+---\n+description: Profile\n+---\n+hello\n*** End Patch\n",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("default mode - treats Agent like Task for safe subagent auto-approval", () => {
  permissionMode.setMode("standard");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Agent",
    {
      subagent_type: "recall",
      prompt: "find prior notes",
      description: "Search history",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

test("default mode - auto-approves the sandboxed memory worker", () => {
  permissionMode.setMode("standard");

  const result = checkPermission(
    "Agent",
    {
      subagent_type: "memory",
      prompt: "Remember that the user prefers tabs",
      description: "Update memory",
    },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Default behavior for tool");
});

// ============================================================================
// Permission Mode: unrestricted
// ============================================================================

test("unrestricted mode - allows all tools", () => {
  permissionMode.setMode("unrestricted");

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
  expect(bashResult.reason).toBe("Permission mode: unrestricted");

  const writeResult = checkPermission(
    "Write",
    { file_path: "/etc/passwd" },
    permissions,
    "/Users/test/project",
  );
  expect(writeResult.decision).toBe("allow");
});

test("unrestricted mode - does NOT override deny rules", () => {
  permissionMode.setMode("unrestricted");

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

  // Deny rules take precedence even in unrestricted mode
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
});

test("unrestricted mode - does NOT override alwaysAsk rules", () => {
  permissionMode.setMode("unrestricted");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    alwaysAsk: ["Bash(git push:*)"],
  };

  const result = checkPermission(
    "Bash",
    { command: "git push origin main" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("alwaysAsk");
  expect(result.matchedRule).toBe("Bash(git push:*)");
  expect(result.reason).toBe("Matched alwaysAsk rule");
});

test("unrestricted mode - deny rules override alwaysAsk rules", () => {
  permissionMode.setMode("unrestricted");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Bash(git push:*)"],
    ask: [],
    alwaysAsk: ["Bash(git push:*)"],
  };

  const result = checkPermission(
    "Bash",
    { command: "git push origin main" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
});

test("unrestricted mode - regular ask rules still auto-allow", () => {
  permissionMode.setMode("unrestricted");

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

  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Permission mode: unrestricted");
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

test("acceptEdits mode - allows ApplyPatch", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "ApplyPatch",
    {
      input:
        "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
  expect(result.reason).toBe("Permission mode: acceptEdits");
});

test("acceptEdits mode - allows memory", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "memory",
    {
      command: "create",
      reason: "seed",
      path: "system/human/profile.md",
      description: "Profile",
      file_text: "hello",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
  expect(result.reason).toBe("Permission mode: acceptEdits");
});

test("acceptEdits mode - allows memory_apply_patch", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "memory_apply_patch",
    {
      reason: "seed",
      input:
        "*** Begin Patch\n*** Add File: system/human/profile.md\n+---\n+description: Profile\n+---\n+hello\n*** End Patch\n",
    },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
  expect(result.reason).toBe("Permission mode: acceptEdits");
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
// Permission Mode: strict
// ============================================================================

test("strict mode - Read within working directory defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/project/src/index.ts" },
    permissions,
    "/Users/test/project",
  );

  // In standard mode this would auto-allow, but strict mode forces "ask"
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - Glob within working directory defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Glob",
    { path: "/Users/test/project/**/*.ts" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - Grep within working directory defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Grep",
    { path: "/Users/test/project/src", pattern: "TODO" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - read-only shell command defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Bash",
    { command: "ls -la /Users/test/project" },
    permissions,
    "/Users/test/project",
  );

  // In standard mode, read-only shell commands auto-allow; strict mode forces "ask"
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - Skill tool defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Skill",
    { skill: "pdf" },
    permissions,
    "/Users/test/project",
  );

  // In standard mode, Skill auto-allows; strict mode forces "ask"
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - memory tool defaults to ask (no auto-allow)", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "memory",
    {
      command: "create",
      reason: "seed",
      path: "system/human/profile.md",
      description: "Profile",
      file_text: "hello",
    },
    permissions,
    "/Users/test/project",
  );

  // In standard mode, memory auto-allows; strict mode forces "ask"
  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - Write tool defaults to ask", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt", content: "hello" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("ask");
  expect(result.reason).toBe("Default behavior for tool");
});

test("strict mode - does NOT override deny rules", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: ["Read"],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/project/src/index.ts" },
    permissions,
    "/Users/test/project",
  );

  // Deny rules still take precedence
  expect(result.decision).toBe("deny");
  expect(result.reason).toBe("Matched deny rule");
});

test("strict mode - does NOT override alwaysAsk rules", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    alwaysAsk: ["Read"],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/project/src/index.ts" },
    permissions,
    "/Users/test/project",
  );

  // alwaysAsk rules still take precedence
  expect(result.decision).toBe("alwaysAsk");
  expect(result.reason).toBe("Matched alwaysAsk rule");
});

test("strict mode - explicit allow rules still work", () => {
  permissionMode.setMode("strict");

  const permissions: PermissionRules = {
    allow: ["Read"],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/project/src/index.ts" },
    permissions,
    "/Users/test/project",
  );

  // Explicit allow rules still work
  expect(result.decision).toBe("allow");
  expect(result.reason).toBe("Matched allow rule");
});

test("strict mode - CLI --allowedTools still work", () => {
  permissionMode.setMode("strict");
  cliPermissions.setAllowedTools("Read");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Read",
    { file_path: "/Users/test/project/src/index.ts" },
    permissions,
    "/Users/test/project",
  );

  // CLI --allowedTools still allows the tool
  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toContain("(CLI)");
  expect(result.reason).toBe("Matched --allowedTools flag");
});

// ============================================================================
// Default decisions for tools that only touch agent-owned state
// ============================================================================

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

test.each([
  ["TaskCreate", { subject: "Plan", description: "Outline the work" }],
  ["TaskGet", { taskId: "1" }],
  ["TaskList", {}],
  ["TaskUpdate", { taskId: "1", status: "completed" }],
  ["read_artifact_file", { path: "notes/today.md" }],
  ["write_artifact_file", { path: "notes/today.md", content: "hello" }],
  ["Wake", { action: "create", prompt: "check back", after_seconds: 60 }],
])("standard and acceptEdits modes run %s without asking", (tool, args) => {
  for (const mode of ["standard", "acceptEdits"] as const) {
    permissionMode.setMode(mode);
    const result = checkPermission(tool, args, NO_RULES, "/Users/test/project");
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Default behavior for tool");
  }
});

test.each([
  ["ViewImage", "path"],
  ["ReadLSP", "file_path"],
])("%s runs without asking only inside the working directory", (tool, key) => {
  permissionMode.setMode("standard");
  // resolve() keeps these absolute on every platform (drive-rooted on Windows).
  const project = resolve("/Users/test/project");

  const inside = checkPermission(
    tool,
    { [key]: join(project, "src", "diagram.png") },
    NO_RULES,
    project,
  );
  expect(inside.decision).toBe("allow");
  expect(inside.reason).toBe("Within working directory");

  const outside = checkPermission(
    tool,
    { [key]: resolve(project, "..", "elsewhere", "diagram.png") },
    NO_RULES,
    project,
  );
  expect(outside.decision).toBe("ask");
});

test("standard mode - SetWorkingDirectory still asks", () => {
  // Moving the working directory widens where file tools run without asking.
  permissionMode.setMode("standard");
  const result = checkPermission(
    "SetWorkingDirectory",
    { path: "/" },
    NO_RULES,
    "/Users/test/project",
  );
  expect(result.decision).toBe("ask");
});

test("strict mode - agent-owned-state tools still ask", () => {
  permissionMode.setMode("strict");
  for (const tool of ["TaskCreate", "Wake", "write_artifact_file"]) {
    const result = checkPermission(tool, {}, NO_RULES, "/Users/test/project");
    expect(result.decision).toBe("ask");
  }
});
