import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { checkPermission } from "../permissions/checker";
import { cliPermissions } from "../permissions/cli";
import { permissionMode } from "../permissions/mode";
import type { PermissionRules } from "../permissions/types";

// Clean up after each test
afterEach(() => {
  permissionMode.reset();
  cliPermissions.clear();
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

test("default mode - auto-allows memory", () => {
  permissionMode.setMode("default");

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
  permissionMode.setMode("default");

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

test("bypassPermissions mode - ExitPlanMode always requires approval", () => {
  permissionMode.setMode("bypassPermissions");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  // ExitPlanMode should NOT be auto-approved in yolo mode
  const exitResult = checkPermission(
    "ExitPlanMode",
    {},
    permissions,
    "/Users/test/project",
  );
  expect(exitResult.decision).toBe("ask");

  const exitSnakeResult = checkPermission(
    "exit_plan_mode",
    {},
    permissions,
    "/Users/test/project",
  );
  expect(exitSnakeResult.decision).toBe("ask");

  // EnterPlanMode should still be auto-approved
  const enterResult = checkPermission(
    "EnterPlanMode",
    {},
    permissions,
    "/Users/test/project",
  );
  expect(enterResult.decision).toBe("allow");
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

test("plan mode - allows ViewImage", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "ViewImage",
    { path: "/Users/test/image.png" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows TaskOutput", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "TaskOutput",
    { task_id: "task_1" },
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

test("memory mode - allows broad read-only tools", () => {
  permissionMode.setMode("memory");

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
  expect(result.matchedRule).toBe("memory mode");
});

test("memory mode - denies non-memory mutation helper tools", () => {
  permissionMode.setMode("memory");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const todoWriteResult = checkPermission(
    "TodoWrite",
    { todos: [{ content: "x", status: "pending", priority: "high" }] },
    permissions,
    "/Users/test/project",
  );
  expect(todoWriteResult.decision).toBe("deny");

  const updatePlanResult = checkPermission(
    "update_plan",
    { plan: [{ step: "x", status: "in_progress" }] },
    permissions,
    "/Users/test/project",
  );
  expect(updatePlanResult.decision).toBe("deny");
});

test("memory mode - allows Write inside MEMORY_DIR", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Write",
      { file_path: "system/test.md" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );

    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBe("memory mode");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - denies Write outside memory roots", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Write",
      { file_path: "/Users/test/project/README.md" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );

    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("memory mode");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - allows Write inside parent memory when LETTA_MEMORY_SCOPE grants it", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalMemoryScope = process.env.LETTA_MEMORY_SCOPE;
  const originalAgentId = process.env.AGENT_ID;
  const home = homedir();
  const parentMemoryPath = join(
    home,
    ".letta",
    "agents",
    "agent-parent",
    "memory",
  );
  delete process.env.MEMORY_DIR;
  process.env.LETTA_MEMORY_SCOPE = "agent-parent";
  process.env.AGENT_ID = "agent-self";

  try {
    const result = checkPermission(
      "Write",
      { file_path: "system/parent.md" },
      { allow: [], deny: [], ask: [] },
      parentMemoryPath,
    );

    expect(result.decision).toBe("allow");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalMemoryScope === undefined)
      delete process.env.LETTA_MEMORY_SCOPE;
    else process.env.LETTA_MEMORY_SCOPE = originalMemoryScope;
    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;
  }
});

test("memory mode - no roots allows reads but denies mutations", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalMemoryScope = process.env.LETTA_MEMORY_SCOPE;
  delete process.env.MEMORY_DIR;
  delete process.env.LETTA_MEMORY_SCOPE;

  try {
    const readResult = checkPermission(
      "Read",
      { file_path: "/tmp/test.txt" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );
    expect(readResult.decision).toBe("allow");

    const writeResult = checkPermission(
      "Write",
      { file_path: "/tmp/test.txt" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );
    expect(writeResult.decision).toBe("deny");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalMemoryScope === undefined)
      delete process.env.LETTA_MEMORY_SCOPE;
    else process.env.LETTA_MEMORY_SCOPE = originalMemoryScope;
  }
});

test("memory mode - denies mixed-target ApplyPatch when any target is outside allowed roots", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "ApplyPatch",
      {
        input:
          "*** Begin Patch\n*** Add File: system/ok.md\n+ok\n*** Add File: /Users/test/project/bad.md\n+bad\n*** End Patch\n",
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );

    expect(result.decision).toBe("deny");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - CLI allowedTools cannot widen writes outside roots", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";
  cliPermissions.setAllowedTools("Write,Bash");

  try {
    const writeResult = checkPermission(
      "Write",
      { file_path: "/Users/test/project/outside.md" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );
    expect(writeResult.decision).toBe("deny");

    const bashResult = checkPermission(
      "Bash",
      { command: "cd /Users/test/project && git push" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );
    expect(bashResult.decision).toBe("deny");
  } finally {
    cliPermissions.clear();
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - allows scoped git push from MEMORY_DIR working directory", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const bashResult = checkPermission(
      "Bash",
      { command: "git push" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(bashResult.decision).toBe("allow");
    expect(bashResult.matchedRule).toBe("memory mode");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - allows builtin env-based worktree setup commands", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalWorktreeDir = process.env.WORKTREE_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";
  process.env.WORKTREE_DIR =
    "/Users/test/.letta/agents/agent-1/memory-worktrees";

  try {
    const bashResult = checkPermission(
      "Bash",
      {
        command: [
          'BRANCH="defrag-123"',
          'mkdir -p "$WORKTREE_DIR"',
          'cd "$MEMORY_DIR"',
          'git worktree add "$WORKTREE_DIR/$BRANCH" -b "$BRANCH"',
        ].join("\n"),
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(bashResult.decision).toBe("allow");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalWorktreeDir === undefined) delete process.env.WORKTREE_DIR;
    else process.env.WORKTREE_DIR = originalWorktreeDir;
  }
});

test("memory mode - denies command substitution inside scoped shell commands", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const bashResult = checkPermission(
      "Bash",
      {
        command:
          'cd /Users/test/.letta/agents/agent-1/memory && git commit -m "$(touch /tmp/pwn)"',
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(bashResult.decision).toBe("deny");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - denies git rebase exec hooks inside scoped shell commands", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const bashResult = checkPermission(
      "Bash",
      {
        command:
          'cd /Users/test/.letta/agents/agent-1/memory && git rebase --exec "touch /tmp/pwn" main',
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(bashResult.decision).toBe("deny");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("plan mode deny reason includes exact apply_patch relative path hint", () => {
  permissionMode.setMode("plan");
  const workingDirectory = join(homedir(), "dev", "repo");
  const planPath = join(homedir(), ".letta", "plans", "unit-test-plan.md");
  const expectedRelativePath = relative(workingDirectory, planPath).replace(
    /\\/g,
    "/",
  );
  permissionMode.setPlanFilePath(planPath);

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "Write",
    { file_path: "/tmp/test.txt" },
    permissions,
    workingDirectory,
  );

  expect(result.decision).toBe("deny");
  expect(result.reason).toContain(
    `If using apply_patch, use this exact relative path in patch headers: ${expectedRelativePath}.`,
  );
});

test("plan mode - allows Write to plan markdown file", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const planPath = join(homedir(), ".letta", "plans", "unit-test-plan.md");
  const result = checkPermission(
    "Write",
    { file_path: planPath },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - allows ApplyPatch with relative path to plan file", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const workingDirectory = join(homedir(), "dev", "repo");
  const planPath = join(homedir(), ".letta", "plans", "zesty-witty-cloud.md");
  const relativePlanPath = relative(workingDirectory, planPath);
  const patch = `*** Begin Patch
*** Add File: ${relativePlanPath}
+## Plan
*** End Patch`;

  const result = checkPermission(
    "ApplyPatch",
    { input: patch },
    permissions,
    workingDirectory,
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - denies ApplyPatch when any target is outside plans dir", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const workingDirectory = join(homedir(), "dev", "repo");
  const planPath = join(homedir(), ".letta", "plans", "zesty-witty-cloud.md");
  const relativePlanPath = relative(workingDirectory, planPath);
  const patch = `*** Begin Patch
*** Add File: ${relativePlanPath}
+## Plan
*** Update File: src/App.tsx
@@
-old
+new
*** End Patch`;

  const result = checkPermission(
    "ApplyPatch",
    { input: patch },
    permissions,
    workingDirectory,
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
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

test("plan mode - allows Bash heredoc write to plan file", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const planPath = join(homedir(), ".letta", "plans", "unit-test-plan.md");
  const command = `cat > ${planPath} <<'EOF'\n# Plan\n- step 1\nEOF`;

  const result = checkPermission(
    "Bash",
    { command },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - denies Bash heredoc write outside plans dir", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const command = "cat > /tmp/not-a-plan.md <<'EOF'\n# Plan\nEOF";

  const result = checkPermission(
    "Bash",
    { command },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("deny");
  expect(result.matchedRule).toBe("plan mode");
});

test("plan mode - denies Bash heredoc write when extra commands follow", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const planPath = join(homedir(), ".letta", "plans", "unit-test-plan.md");
  const command = `cat > ${planPath} <<'EOF'\n# Plan\nEOF\necho 'extra command'`;

  const result = checkPermission(
    "Bash",
    { command },
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
    { command: "cd src && git status" },
    permissions,
    "/Users/test/project",
  );
  expect(cdGitResult.decision).toBe("allow");

  // cd && git show should be allowed
  const cdGitShowResult = checkPermission(
    "Bash",
    { command: "cd src && git show abc123" },
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

  // quoted pipes in regex patterns should be treated as literals and allowed
  const quotedPipeResult = checkPermission(
    "Bash",
    {
      command:
        'rg -n "memfs|memory filesystem|memory_filesystem|skills/|SKILL.md|git-backed|sync" letta tests -S',
    },
    permissions,
    "/Users/test/project",
  );
  expect(quotedPipeResult.decision).toBe("allow");

  // cd && dangerous command should still be denied
  const cdDangerousResult = checkPermission(
    "Bash",
    { command: "cd src && npm install" },
    permissions,
    "/Users/test/project",
  );
  expect(cdDangerousResult.decision).toBe("deny");

  // absolute paths should be allowed in plan mode for read-only analysis
  const absoluteReadResult = checkPermission(
    "Bash",
    { command: "sed -n '1,80p' /tmp/logs/output.log" },
    permissions,
    "/Users/test/project",
  );
  expect(absoluteReadResult.decision).toBe("allow");

  // traversal paths should also be allowed in plan mode for read-only analysis
  const traversalReadResult = checkPermission(
    "Bash",
    { command: "cat ../shared/config.json" },
    permissions,
    "/Users/test/project",
  );
  expect(traversalReadResult.decision).toBe("allow");
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

test("plan mode - remembers and restores previous mode", () => {
  permissionMode.setMode("bypassPermissions");
  expect(permissionMode.getMode()).toBe("bypassPermissions");

  // Enter plan mode - should remember prior mode.
  permissionMode.setMode("plan");
  expect(permissionMode.getMode()).toBe("plan");
  expect(permissionMode.getModeBeforePlan()).toBe("bypassPermissions");

  // Exit plan mode by restoring previous mode.
  permissionMode.setMode(permissionMode.getModeBeforePlan() ?? "default");
  expect(permissionMode.getMode()).toBe("bypassPermissions");

  // Once we leave plan mode, the remembered mode is consumed.
  expect(permissionMode.getModeBeforePlan()).toBe(null);
});

test("plan mode - allows read_file_gemini", () => {
  permissionMode.setMode("plan");

  const permissions: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
  };

  const result = checkPermission(
    "read_file_gemini",
    { file_path: "/tmp/test.txt" },
    permissions,
    "/Users/test/project",
  );

  expect(result.decision).toBe("allow");
  expect(result.matchedRule).toBe("plan mode");
});
