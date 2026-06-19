import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkPermission } from "@/permissions/checker";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";

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

// ============================================================================
// Permission Mode: plan
// ============================================================================

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

test("memory mode - allows Bash redirection inside MEMORY_DIR", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      {
        command:
          'echo "test content" > "$MEMORY_DIR/skills/example/SKILL.md" && ls -la "$MEMORY_DIR/skills/example/"',
      },
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

test("memory mode - applies shell scoping to exec_command cmd", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "exec_command",
      { cmd: 'echo "test content" > "$MEMORY_DIR/system/test.md"' },
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

test("memory mode - allows write_stdin polls but denies stdin writes", () => {
  permissionMode.setMode("memory");

  const pollResult = checkPermission(
    "write_stdin",
    { session_id: 1, chars: "" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );
  expect(pollResult.decision).toBe("allow");
  expect(pollResult.matchedRule).toBe("memory mode");

  const writeResult = checkPermission(
    "write_stdin",
    { session_id: 1, chars: "echo pwn\n" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );
  expect(writeResult.decision).toBe("deny");
  expect(writeResult.matchedRule).toBe("memory mode");
});

test("memory mode - denies Bash redirection outside MEMORY_DIR", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      { command: 'echo "test content" > /tmp/outside-memory.txt' },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );

    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("memory mode");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode - defers to the kernel sandbox when the sentinel is set (full replacement)", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalSentinel = process.env[SANDBOX_ENV_VAR];
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";
  process.env[SANDBOX_ENV_VAR] = "bwrap";

  try {
    // A network shell command (non-read-only) is statically denied, but with the
    // kernel confining the whole process the mode defers and auto-allows it.
    const curl = checkPermission(
      "Bash",
      { command: "curl https://example.com" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(curl.decision).toBe("allow");

    // A write outside the memory dir but under the harness state dir is also
    // deferred (the kernel caps writes at ~/.letta).
    const harnessWrite = checkPermission(
      "Write",
      { file_path: "/Users/test/.letta/.lettasettings" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/project",
    );
    expect(harnessWrite.decision).toBe("allow");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalSentinel === undefined) delete process.env[SANDBOX_ENV_VAR];
    else process.env[SANDBOX_ENV_VAR] = originalSentinel;
  }
});

test("memory mode - still enforces statically when no sandbox backend (sentinel unset)", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalSentinel = process.env[SANDBOX_ENV_VAR];
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";
  delete process.env[SANDBOX_ENV_VAR];

  try {
    // Without the kernel confining the process, the static memory-mode contract
    // is still the enforcement: a network shell command is denied.
    const curl = checkPermission(
      "Bash",
      { command: "curl https://example.com" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(curl.decision).toBe("deny");
    expect(curl.matchedRule).toBe("memory mode");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalSentinel === undefined) delete process.env[SANDBOX_ENV_VAR];
    else process.env[SANDBOX_ENV_VAR] = originalSentinel;
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

test("memory mode - allows Write inside parent memory for subagents", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
  const originalAgentId = process.env.AGENT_ID;
  const originalParentAgentId = process.env.LETTA_PARENT_AGENT_ID;
  const originalAgentRole = process.env.LETTA_CODE_AGENT_ROLE;
  const home = homedir();
  const parentMemoryPath = join(
    home,
    ".letta",
    "agents",
    "agent-parent",
    "memory",
  );
  process.env.MEMORY_DIR = parentMemoryPath;
  process.env.LETTA_MEMORY_DIR = parentMemoryPath;
  process.env.AGENT_ID = "agent-self";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent";
  process.env.LETTA_CODE_AGENT_ROLE = "subagent";

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
    if (originalLettaMemoryDir === undefined)
      delete process.env.LETTA_MEMORY_DIR;
    else process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;
    if (originalParentAgentId === undefined)
      delete process.env.LETTA_PARENT_AGENT_ID;
    else process.env.LETTA_PARENT_AGENT_ID = originalParentAgentId;
    if (originalAgentRole === undefined)
      delete process.env.LETTA_CODE_AGENT_ROLE;
    else process.env.LETTA_CODE_AGENT_ROLE = originalAgentRole;
  }
});

test("memory mode - no roots allows reads but denies mutations", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
  const originalAgentId = process.env.AGENT_ID;
  const originalLettaAgentId = process.env.LETTA_AGENT_ID;
  const originalParentAgentId = process.env.LETTA_PARENT_AGENT_ID;
  delete process.env.MEMORY_DIR;
  delete process.env.LETTA_MEMORY_DIR;
  delete process.env.AGENT_ID;
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_PARENT_AGENT_ID;

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
    if (originalLettaMemoryDir === undefined)
      delete process.env.LETTA_MEMORY_DIR;
    else process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;
    if (originalLettaAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = originalLettaAgentId;
    if (originalParentAgentId === undefined)
      delete process.env.LETTA_PARENT_AGENT_ID;
    else process.env.LETTA_PARENT_AGENT_ID = originalParentAgentId;
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

// ============================================================================
// Permission Mode: memory — instructive denial reasons
// ============================================================================
// The bare "Permission mode: memory" reason gives the agent no signal for
// how to recover. These tests assert that each deny path produces a
// category-specific reason that names the offending construct and a
// concrete remediation idiom.

test("memory mode reason - tool not allowed names the tool", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "WebSearch",
      { query: "letta" },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Memory mode");
    expect(result.reason).toContain("WebSearch");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode reason - Write outside roots names target and roots", () => {
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
    expect(result.reason).toContain("/Users/test/project/README.md");
    expect(result.reason).toContain("/Users/test/.letta/agents/agent-1/memory");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode reason - Bash with $() points at variable usage", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      {
        command:
          'cd "$MEMORY_DIR" && CHILD=$(echo $LETTA_AGENT_ID) && echo $CHILD',
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("command substitution");
    expect(result.reason).toContain("$LETTA_AGENT_ID");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode reason - Bash with python3 points at heredoc", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      {
        command: `cd "$MEMORY_DIR" && python3 -c "open('x.md','w').write('hi')"`,
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("python3");
    expect(result.reason).toContain("heredoc");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode reason - Bash redirect outside roots names target", () => {
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      { command: 'echo "hi" > /tmp/outside.txt' },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("redirects only to paths under");
    expect(result.reason).toContain("/tmp/outside.txt");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});

test("memory mode reason - existing scoped denials get instructive reason too", () => {
  // Regression: existing scoped-denial coverage should also surface the
  // specific category reason, not the generic "Permission mode: memory".
  permissionMode.setMode("memory");
  const originalMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

  try {
    const result = checkPermission(
      "Bash",
      {
        command:
          'cd /Users/test/.letta/agents/agent-1/memory && git commit -m "$(touch /tmp/pwn)"',
      },
      { allow: [], deny: [], ask: [] },
      "/Users/test/.letta/agents/agent-1/memory",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("command substitution");
    expect(result.reason).not.toBe("Permission mode: memory");
  } finally {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
  }
});
