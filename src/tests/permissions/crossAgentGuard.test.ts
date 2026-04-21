import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, parse } from "node:path";

import { checkPermission } from "../../permissions/checker";
import { cliPermissions } from "../../permissions/cli";
import {
  evaluateCrossAgentGuard,
  extractTargetAgentPaths,
  resolveAllowedAgents,
} from "../../permissions/crossAgentGuard";
import { permissionMode } from "../../permissions/mode";

const HOME = homedir();
const SELF = "agent-self";
const OTHER = "agent-other";
const THIRD = "agent-third";

function selfMemory(rel = ""): string {
  return join(HOME, ".letta", "agents", SELF, "memory", rel);
}

function otherMemory(rel = ""): string {
  return join(HOME, ".letta", "agents", OTHER, "memory", rel);
}

function otherWorktree(rel = ""): string {
  return join(HOME, ".letta", "agents", OTHER, "memory-worktrees", rel);
}

function thirdMemory(rel = ""): string {
  return join(HOME, ".letta", "agents", THIRD, "memory", rel);
}

const ENV_KEYS_TO_RESET = [
  "AGENT_ID",
  "LETTA_AGENT_ID",
  "LETTA_PARENT_AGENT_ID",
  "LETTA_MEMORY_SCOPE",
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
] as const;

function snapshotEnv(): Partial<
  Record<(typeof ENV_KEYS_TO_RESET)[number], string>
> {
  const snapshot: Record<string, string> = {};
  for (const key of ENV_KEYS_TO_RESET) {
    const value = process.env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function restoreEnv(
  snapshot: Partial<Record<(typeof ENV_KEYS_TO_RESET)[number], string>>,
): void {
  for (const key of ENV_KEYS_TO_RESET) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

let baselineEnv: ReturnType<typeof snapshotEnv>;

beforeEach(() => {
  baselineEnv = snapshotEnv();
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
  process.env.AGENT_ID = SELF;
  cliPermissions.clear();
  permissionMode.reset();
});

afterEach(() => {
  restoreEnv(baselineEnv);
  cliPermissions.clear();
  permissionMode.reset();
});

// ---------------------------------------------------------------------------
// resolveAllowedAgents
// ---------------------------------------------------------------------------

describe("resolveAllowedAgents", () => {
  test("self-only when no scope is configured", () => {
    const allowed = resolveAllowedAgents();
    expect([...allowed.ids]).toEqual([SELF]);
    expect(allowed.sources.self).toBe(SELF);
    expect(allowed.sources.env).toEqual([]);
    expect(allowed.sources.cli).toEqual([]);
  });

  test("LETTA_MEMORY_SCOPE (comma-separated) adds to allowed set", () => {
    process.env.LETTA_MEMORY_SCOPE = "agent-a,agent-b";
    const allowed = resolveAllowedAgents();
    expect(allowed.ids).toEqual(new Set([SELF, "agent-a", "agent-b"]));
    expect(allowed.sources.env).toEqual(["agent-a", "agent-b"]);
  });

  test("LETTA_MEMORY_SCOPE (whitespace-separated) also works", () => {
    process.env.LETTA_MEMORY_SCOPE = "agent-a  agent-b";
    const allowed = resolveAllowedAgents();
    expect(allowed.ids).toEqual(new Set([SELF, "agent-a", "agent-b"]));
  });

  test("--memory-scope CLI flag adds to allowed set", () => {
    cliPermissions.setMemoryScope("agent-cli1,agent-cli2");
    const allowed = resolveAllowedAgents();
    expect(allowed.ids).toEqual(new Set([SELF, "agent-cli1", "agent-cli2"]));
    expect(allowed.sources.cli).toEqual(["agent-cli1", "agent-cli2"]);
  });

  test("all three sources combine without duplicates", () => {
    process.env.LETTA_MEMORY_SCOPE = "agent-a,agent-shared";
    cliPermissions.setMemoryScope("agent-shared agent-b");
    const allowed = resolveAllowedAgents();
    expect(allowed.ids).toEqual(
      new Set([SELF, "agent-a", "agent-shared", "agent-b"]),
    );
  });

  test("explicit currentAgentId overrides env lookup", () => {
    process.env.AGENT_ID = "env-agent";
    const allowed = resolveAllowedAgents({ currentAgentId: "explicit-agent" });
    expect(allowed.sources.self).toBe("explicit-agent");
    expect(allowed.ids.has("explicit-agent")).toBe(true);
    expect(allowed.ids.has("env-agent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTargetAgentPaths
// ---------------------------------------------------------------------------

describe("extractTargetAgentPaths", () => {
  test("file-tool targeting own memory", () => {
    const result = extractTargetAgentPaths(
      "Write",
      { file_path: selfMemory("system/persona.md") },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(true);
    expect(result.agentIds).toEqual(new Set([SELF]));
  });

  test("file-tool targeting another agent's memory", () => {
    const result = extractTargetAgentPaths(
      "Write",
      { file_path: otherMemory("system/persona.md") },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(true);
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("file-tool targeting a non-agent path", () => {
    const result = extractTargetAgentPaths(
      "Write",
      { file_path: "/tmp/some-project/src/index.ts" },
      "/tmp/some-project",
    );
    expect(result.anyAgentScoped).toBe(false);
    expect(result.agentIds.size).toBe(0);
  });

  test("tilde-based paths resolve against home dir", () => {
    const result = extractTargetAgentPaths(
      "Read",
      { file_path: `~/.letta/agents/${OTHER}/memory/system/x.md` },
      "/tmp",
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("memory-worktrees paths are also agent-scoped", () => {
    const result = extractTargetAgentPaths(
      "Write",
      { file_path: otherWorktree("defrag-12345/system/x.md") },
      "/tmp",
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("NotebookEdit uses notebook_path", () => {
    const result = extractTargetAgentPaths(
      "NotebookEdit",
      { notebook_path: otherMemory("notebook.ipynb") },
      "/tmp",
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("ApplyPatch parses all file directives", () => {
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${selfMemory("system/a.md")}`,
      `*** Update File: ${otherMemory("system/b.md")}`,
      `*** Delete File: ${thirdMemory("system/c.md")}`,
      "*** End Patch",
    ].join("\n");

    const result = extractTargetAgentPaths(
      "ApplyPatch",
      { input: patch },
      "/tmp",
    );

    expect(result.agentIds).toEqual(new Set([SELF, OTHER, THIRD]));
    expect(result.anyAgentScoped).toBe(true);
  });

  test("memory_apply_patch behaves like ApplyPatch", () => {
    const patch = `*** Begin Patch\n*** Update File: ${otherMemory("system/x.md")}\n*** End Patch`;
    const result = extractTargetAgentPaths(
      "memory_apply_patch",
      { input: patch },
      "/tmp",
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("Bash command referencing another agent's memory literally", () => {
    const result = extractTargetAgentPaths(
      "Bash",
      { command: `cat ${otherMemory("system/persona.md")}` },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(true);
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("Bash command with MEMORY_DIR env var pointing at another agent", () => {
    const result = extractTargetAgentPaths(
      "Bash",
      { command: "rm -rf $MEMORY_DIR/system" },
      "/tmp",
      { ...process.env, MEMORY_DIR: otherMemory() } as NodeJS.ProcessEnv,
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("Bash read-only inspection against another agent's memory still trips the guard", () => {
    const result = extractTargetAgentPaths(
      "Bash",
      { command: `ls ${otherMemory()}` },
      "/tmp",
    );
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("Bash command against /tmp does not trip the guard", () => {
    const result = extractTargetAgentPaths(
      "Bash",
      { command: "ls /tmp && echo ok" },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(false);
  });

  test("Glob/Grep against another agent's memory", () => {
    expect(
      extractTargetAgentPaths("Glob", { path: otherMemory() }, "/tmp").agentIds,
    ).toEqual(new Set([OTHER]));
    expect(
      extractTargetAgentPaths("Grep", { path: otherMemory() }, "/tmp").agentIds,
    ).toEqual(new Set([OTHER]));
  });

  test("shell tool aliases (run_shell_command, shell_command) work", () => {
    expect(
      extractTargetAgentPaths(
        "run_shell_command",
        { command: `cat ${otherMemory()}/x.md` },
        "/tmp",
      ).agentIds,
    ).toEqual(new Set([OTHER]));
    expect(
      extractTargetAgentPaths(
        "shell_command",
        { command: `ls ${otherMemory()}` },
        "/tmp",
      ).agentIds,
    ).toEqual(new Set([OTHER]));
  });
});

// ---------------------------------------------------------------------------
// evaluateCrossAgentGuard
// ---------------------------------------------------------------------------

describe("evaluateCrossAgentGuard", () => {
  test("returns null for own memory", () => {
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: selfMemory("system/a.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("returns null for non-agent paths", () => {
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: "/tmp/project/foo.md" },
      "/tmp/project",
    );
    expect(result).toBeNull();
  });

  test("denies when targeting another agent's memory with no scope", () => {
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.matchedRule).toBe("cross-agent guard");
    expect(result?.offendingAgentIds).toEqual([OTHER]);
    expect(result?.reason).toMatch(/cross-agent memory guard/);
  });

  test("passes through when other agent is in LETTA_MEMORY_SCOPE", () => {
    process.env.LETTA_MEMORY_SCOPE = OTHER;
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("passes through when other agent is in --memory-scope", () => {
    cliPermissions.setMemoryScope(OTHER);
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("partial scope: denies when any target is outside allowed set", () => {
    process.env.LETTA_MEMORY_SCOPE = OTHER; // only OTHER is allowed
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${otherMemory("ok.md")}`,
      `*** Add File: ${thirdMemory("bad.md")}`,
      "*** End Patch",
    ].join("\n");
    const result = evaluateCrossAgentGuard(
      "ApplyPatch",
      { input: patch },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toEqual([THIRD]);
  });

  test("reads are gated (not just writes)", () => {
    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: otherMemory("system/x.md") },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("bash read-only against other agent's memory is gated", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      { command: `cat ${otherMemory()}/system/x.md` },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration with checkPermission — guard is unbypassable by any mode
// ---------------------------------------------------------------------------

describe("checkPermission integration", () => {
  const permissions = { allow: [], deny: [], ask: [] };

  test("bypassPermissions mode does NOT let you write another agent's memory", () => {
    permissionMode.setMode("bypassPermissions");
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      "/tmp",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("cross-agent guard");
  });

  test("acceptEdits mode does NOT let you write another agent's memory", () => {
    permissionMode.setMode("acceptEdits");
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      "/tmp",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("cross-agent guard");
  });

  test("memory mode does NOT let you write another agent's memory without scope", () => {
    permissionMode.setMode("memory");
    process.env.MEMORY_DIR = selfMemory();
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      selfMemory(),
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("cross-agent guard");
  });

  test("memory mode DOES allow writes to scoped agent's memory", () => {
    permissionMode.setMode("memory");
    process.env.LETTA_MEMORY_SCOPE = OTHER;
    process.env.MEMORY_DIR = otherMemory();
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      otherMemory(),
    );
    expect(result.decision).toBe("allow");
  });

  test("reads against another agent's memory are denied across all modes", () => {
    const modes = [
      "default",
      "acceptEdits",
      "plan",
      "memory",
      "bypassPermissions",
    ] as const;
    for (const mode of modes) {
      permissionMode.setMode(mode);
      const result = checkPermission(
        "Read",
        { file_path: otherMemory("system/a.md") },
        permissions,
        "/tmp",
      );
      expect(result.decision).toBe("deny");
      expect(result.matchedRule).toBe("cross-agent guard");
    }
  });

  test("own-memory access is unaffected by guard in every mode", () => {
    process.env.MEMORY_DIR = selfMemory();
    const modes = [
      "default",
      "acceptEdits",
      "memory",
      "bypassPermissions",
    ] as const;
    for (const mode of modes) {
      permissionMode.setMode(mode);
      const result = checkPermission(
        "Read",
        { file_path: selfMemory("system/a.md") },
        permissions,
        selfMemory(),
      );
      // Read on own memory should not be guard-denied (guard returns null,
      // other rules decide; Read defaults to allow).
      expect(result.matchedRule).not.toBe("cross-agent guard");
    }
  });

  test("bash against another agent's memory is denied even in bypassPermissions", () => {
    permissionMode.setMode("bypassPermissions");
    const result = checkPermission(
      "Bash",
      { command: `git -C ${otherMemory()} log` },
      permissions,
      "/tmp",
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("cross-agent guard");
  });

  test("CLI --memory-scope opens access in acceptEdits mode", () => {
    permissionMode.setMode("acceptEdits");
    cliPermissions.setMemoryScope(OTHER);
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      "/tmp",
    );
    // acceptEdits allows writes, and the guard passes since OTHER is scoped.
    expect(result.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Regression tests: known bypass patterns (from real exploit attempts)
//
// Command fixtures below contain shell brace-variable syntax inside plain
// strings. Biome's noTemplateCurlyInString rule flags these, but they are
// intentional: they're shell commands, not mistaken template literals.
// ---------------------------------------------------------------------------

describe("shell bypass regression tests", () => {
  test("enumeration: ls ~/.letta/agents is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      { command: "ls ~/.letta/agents" },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.matchedRule).toBe("cross-agent guard");
  });

  test("enumeration: find over the whole agents tree is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      {
        command: 'find "${HOME}/.letta/agents" -mindepth 1 -maxdepth 1 -type d',
      },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("command substitution: assigning a computed target path is denied", () => {
    // Exploit variant 1 (finds another agent via dynamic path resolution).
    const command = [
      'CURRENT="$AGENT_ID"',
      'BASE="${HOME}/.letta/agents"',
      'TARGET="$(find "$BASE" -mindepth 1 -maxdepth 1 -type d ! -name "$CURRENT" | sort | head -n 1)"',
      'cat "$TARGET/memory/system/persona.md"',
    ].join("\n");
    const result = evaluateCrossAgentGuard("Bash", { command }, "/tmp");
    expect(result).not.toBeNull();
  });

  test("command substitution variant 2 (find -name memory) is denied", () => {
    const command = [
      'CURRENT="$AGENT_ID"',
      'BASE="${HOME}/.letta/agents"',
      'TARGET="$(find "$BASE" -mindepth 2 -maxdepth 2 -type d -name memory | grep -v "/$CURRENT/" | sort | head -n 1)"',
      'cat "$TARGET/system/persona.md"',
    ].join("\n");
    const result = evaluateCrossAgentGuard("Bash", { command }, "/tmp");
    expect(result).not.toBeNull();
  });

  test("literal-but-unknown agent ID in quoted assignment is denied", () => {
    // Exploit variant 3 — the one that actually succeeded previously
    // because the quote-wrapping on the assignment value broke the
    // anchored path regex.
    const command = [
      'TARGET="${HOME}/.letta/agents/agent-0037d3d9-389b-4c02-82ae-d77aa29d1ada/memory"',
      'sed -n "1,80p" "$TARGET/system/persona.md"',
    ].join("\n");
    const result = evaluateCrossAgentGuard("Bash", { command }, "/tmp");
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(
      "agent-0037d3d9-389b-4c02-82ae-d77aa29d1ada",
    );
  });

  test("tilde-expansion with unknown agent ID is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      { command: "cat ~/.letta/agents/agent-victim/memory/system/persona.md" },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("self-targeting references using ${AGENT_ID} pass through", () => {
    process.env.AGENT_ID = SELF;
    const result = evaluateCrossAgentGuard(
      "Bash",
      {
        command:
          'cat "${HOME}/.letta/agents/${AGENT_ID}/memory/system/persona.md"',
      },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("scoped access via LETTA_MEMORY_SCOPE passes through", () => {
    process.env.LETTA_MEMORY_SCOPE =
      "agent-0037d3d9-389b-4c02-82ae-d77aa29d1ada";
    const command =
      'TARGET="${HOME}/.letta/agents/agent-0037d3d9-389b-4c02-82ae-d77aa29d1ada/memory"\n' +
      'cat "$TARGET/system/persona.md"';
    const result = evaluateCrossAgentGuard("Bash", { command }, "/tmp");
    expect(result).toBeNull();
  });

  test("legitimate bash touching nothing under .letta/agents is not denied", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      { command: "ls /tmp && echo ok" },
      "/tmp",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression tests: Grep / Glob ancestor-path bypass.
//
// The classifier used to require `<home>/.letta/agents/<id>/memory` to
// match, so pointing Grep or Glob at `.letta/agents` (the tree root)
// slipped through entirely — leaking file contents and enumerating every
// agent on disk.
// ---------------------------------------------------------------------------

describe("Grep/Glob ancestor-path regression tests", () => {
  const agentsTreeRoot = join(HOME, ".letta", "agents");

  test("Glob with path='<home>/.letta/agents' is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Glob",
      { pattern: "**/*.md", path: agentsTreeRoot },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.matchedRule).toBe("cross-agent guard");
  });

  test("Grep with path='<home>/.letta/agents' is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Grep",
      { pattern: "password|secret|token|api_key", path: agentsTreeRoot },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("Glob pointed at a specific foreign agent's root (no /memory) is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Glob",
      { pattern: "**/*.md", path: join(agentsTreeRoot, OTHER) },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });

  test("Glob pointed at a foreign agent's settings.json (no /memory) is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: join(agentsTreeRoot, OTHER, "settings.json") },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });

  test("Grep with absolute pattern referencing the agents tree is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Glob",
      {
        pattern: join(agentsTreeRoot, "*", "memory", "**", "*.md"),
      },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("Glob with path=$HOME (ancestor of agents tree) is denied — recursive walk would enter it", () => {
    const result = evaluateCrossAgentGuard(
      "Glob",
      { pattern: "**/*.md", path: HOME },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("Grep on the filesystem root is denied for the same reason", () => {
    // Use the home drive's root so the test works on Windows (where `/`
    // resolves to the current drive and may not be an ancestor of the
    // home drive in CI).
    const fsRoot = parse(HOME).root;
    const result = evaluateCrossAgentGuard(
      "Grep",
      { pattern: "secret", path: fsRoot },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("Glob on self memory is allowed", () => {
    process.env.AGENT_ID = SELF;
    const result = evaluateCrossAgentGuard(
      "Glob",
      { pattern: "**/*.md", path: selfMemory() },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("Glob on self agent root (not under /memory) is allowed", () => {
    process.env.AGENT_ID = SELF;
    const result = evaluateCrossAgentGuard(
      "Glob",
      { pattern: "**/*", path: join(agentsTreeRoot, SELF) },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("Grep on a foreign agent is allowed when scoped via LETTA_MEMORY_SCOPE", () => {
    process.env.LETTA_MEMORY_SCOPE = OTHER;
    const result = evaluateCrossAgentGuard(
      "Grep",
      { pattern: "password", path: otherMemory() },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("Read on a single foreign file (not recursive) is still denied", () => {
    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: otherMemory("system/persona.md") },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });

  test("Read on $HOME (ancestor) is not a cross-agent hit — Read targets a single file, not a tree", () => {
    const result = evaluateCrossAgentGuard("Read", { file_path: HOME }, "/tmp");
    // Read on a dir would fail at the tool level anyway; guard shouldn't
    // block generic home-dir file reads.
    expect(result).toBeNull();
  });

  test("ListDir on the agents tree is denied (ListDir is recursive-like for our purposes)", () => {
    const result = evaluateCrossAgentGuard(
      "ListDir",
      { path: agentsTreeRoot },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });
});
