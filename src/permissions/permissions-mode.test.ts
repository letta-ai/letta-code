import { afterEach, expect, test } from "bun:test";
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

test.each(["recall", "memory"])(
  "default mode - treats Agent like Task for safe %s subagent auto-approval",
  (subagentType) => {
    permissionMode.setMode("standard");

    const permissions: PermissionRules = {
      allow: [],
      deny: [],
      ask: [],
    };

    const result = checkPermission(
      "Agent",
      {
        subagent_type: subagentType,
        prompt: "do the safe background task",
        description: "Safe subagent",
      },
      permissions,
      "/Users/test/project",
    );

    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("Default behavior for tool");
  },
);

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

test("acceptEdits mode - allows Replace", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Replace",
    { file_path: "/tmp/test.txt", old_string: "old", new_string: "new" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("acceptEdits mode");
});

test("acceptEdits mode - allows WriteFileGemini", () => {
  permissionMode.setMode("acceptEdits");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "WriteFileGemini",
    { file_path: "/tmp/test.txt", content: "hello" },
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
