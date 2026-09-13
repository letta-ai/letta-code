import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";

import { checkPermission } from "@/permissions/checker";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import {
  evaluateCrossAgentGuard,
  extractTargetAgentPaths,
  isMemoryGuardDisabled,
  resolveAllowedAgents,
} from "@/permissions/cross-agent-guard";
import { permissionMode } from "@/permissions/mode";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";

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
  "LETTA_CODE_AGENT_ROLE",
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_LOCAL_BACKEND_DIR",
  SANDBOX_ENV_VAR,
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
  test("self-only when no parent is configured", () => {
    const allowed = resolveAllowedAgents();
    expect([...allowed]).toEqual([SELF]);
  });

  test("subagent parent ID adds only the parent to the allowed set", () => {
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    process.env.LETTA_PARENT_AGENT_ID = OTHER;
    const allowed = resolveAllowedAgents();
    expect(allowed).toEqual(new Set([SELF, OTHER]));
  });

  test("parent ID is ignored outside subagent processes", () => {
    process.env.LETTA_PARENT_AGENT_ID = OTHER;
    const allowed = resolveAllowedAgents();
    expect(allowed).toEqual(new Set([SELF]));
  });

  test("explicit currentAgentId overrides env lookup", () => {
    process.env.AGENT_ID = "env-agent";
    const allowed = resolveAllowedAgents({ currentAgentId: "explicit-agent" });
    expect(allowed.has("explicit-agent")).toBe(true);
    expect(allowed.has("env-agent")).toBe(false);
  });

  test("memory guard disable flag is ignored for subagents", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    expect(isMemoryGuardDisabled()).toBe(true);

    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    expect(isMemoryGuardDisabled()).toBe(false);
  });

  test("parent memory guard is enabled by default", () => {
    expect(isMemoryGuardDisabled()).toBe(false);
  });

  test("explicit parent disable flag sets the disabled bit", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    expect(isMemoryGuardDisabled()).toBe(true);
  });

  test("clearing CLI overrides restores the enabled default", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    cliPermissions.clear();
    expect(isMemoryGuardDisabled()).toBe(false);
  });

  test("subagents ignore the parent disabled override", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    expect(isMemoryGuardDisabled()).toBe(false);
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

  test("shell tools are not path-analyzed (the kernel sandbox confines spawned shells)", () => {
    // Shell command analysis was removed: spawned shells run inside the kernel
    // filesystem sandbox, so the guard no longer tokenizes shell commands.
    const result = extractTargetAgentPaths(
      "Bash",
      { command: `cat ${otherMemory("system/persona.md")}` },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(false);
    expect(result.agentIds.size).toBe(0);
  });

  test("Glob/Grep against another agent's memory", () => {
    expect(
      extractTargetAgentPaths("Glob", { path: otherMemory() }, "/tmp").agentIds,
    ).toEqual(new Set([OTHER]));
    expect(
      extractTargetAgentPaths("Grep", { path: otherMemory() }, "/tmp").agentIds,
    ).toEqual(new Set([OTHER]));
  });
});

// ---------------------------------------------------------------------------
// evaluateCrossAgentGuard
// ---------------------------------------------------------------------------

describe("evaluateCrossAgentGuard", () => {
  beforeEach(() => {
    cliPermissions.setMemoryGuardDisabled(false);
  });

  test("parent processes apply the guard by default", () => {
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.matchedRule).toBe("cross-agent guard");
  });

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

  test("passes through when parent process disables the guard", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("subagent can access its explicit parent memory with guard enabled", () => {
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    process.env.LETTA_PARENT_AGENT_ID = OTHER;
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: otherMemory("system/a.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("subagent with disabled guard request still denies non-parent agents", () => {
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
    process.env.LETTA_PARENT_AGENT_ID = OTHER;
    cliPermissions.setMemoryGuardDisabled(true);
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

  test("bash against another agent's memory defers to the kernel sandbox (guard returns null)", () => {
    const result = evaluateCrossAgentGuard(
      "Bash",
      { command: `cat ${otherMemory()}/system/x.md` },
      "/tmp",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration with checkPermission — when enabled, guard is unbypassable by any mode
// ---------------------------------------------------------------------------

describe("checkPermission integration", () => {
  const permissions = { allow: [], deny: [], ask: [] };

  beforeEach(() => {
    cliPermissions.setMemoryGuardDisabled(false);
  });

  test("parent processes use normal permissions when guard is explicitly disabled", () => {
    cliPermissions.setMemoryGuardDisabled(true);
    permissionMode.setMode("acceptEdits");
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      "/tmp",
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).not.toBe("cross-agent guard");
  });

  test("unrestricted mode does NOT let you write another agent's memory", () => {
    permissionMode.setMode("unrestricted");
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

  test("reads against another agent's memory are denied across all modes", () => {
    const modes = ["standard", "acceptEdits", "unrestricted"] as const;
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
    const modes = ["standard", "acceptEdits", "unrestricted"] as const;
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

  test("bash against another agent's memory is NOT guard-denied (kernel sandbox confines spawned shells)", () => {
    permissionMode.setMode("unrestricted");
    const result = checkPermission(
      "Bash",
      { command: `git -C ${otherMemory()} log` },
      permissions,
      "/tmp",
    );
    // The static guard no longer analyzes shell commands; the kernel filesystem
    // sandbox confines the spawned shell instead.
    expect(result.matchedRule).not.toBe("cross-agent guard");
  });

  test("CLI --disable-memory-guard opens access in acceptEdits mode", () => {
    permissionMode.setMode("acceptEdits");
    cliPermissions.setMemoryGuardDisabled(true);
    const result = checkPermission(
      "Write",
      { file_path: otherMemory("system/a.md") },
      permissions,
      "/tmp",
    );
    // acceptEdits allows writes, and the guard is intentionally disabled.
    expect(result.decision).toBe("allow");
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

  beforeEach(() => {
    cliPermissions.setMemoryGuardDisabled(false);
  });

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

  test("Grep on a foreign agent is allowed when the guard is disabled", () => {
    cliPermissions.setMemoryGuardDisabled(true);
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

describe("symlink-escape (realpath classification of in-process file tools)", () => {
  // Real temp dirs with real symlinks: the realpath classification only has
  // teeth when the paths actually exist on disk. Each test builds a throwaway
  // home (~/.letta/agents/<id>/memory) and injects it as the guard's homeDir.
  const tempHomes: string[] = [];

  function makeTempHome(): string {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "xa-guard-")));
    tempHomes.push(home);
    return home;
  }

  function agentMemory(home: string, id: string, rel = ""): string {
    return join(home, ".letta", "agents", id, "memory", rel);
  }

  afterEach(() => {
    while (tempHomes.length) {
      rmSync(tempHomes.pop() as string, { recursive: true, force: true });
    }
  });

  test("Read through a symlink into another agent's memory is attributed to that agent", () => {
    const home = makeTempHome();
    const otherMem = agentMemory(home, "agent-other");
    mkdirSync(otherMem, { recursive: true });
    writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

    // A benign-looking symlink in the user's project pointing into other's memory.
    const projectDir = join(home, "project");
    mkdirSync(projectDir, { recursive: true });
    const link = join(projectDir, "link");
    symlinkSync(otherMem, link);

    const targets = extractTargetAgentPaths(
      "Read",
      { file_path: join(link, "secret.md") },
      projectDir,
      {},
      home,
    );

    expect(targets.anyAgentScoped).toBe(true);
    expect([...targets.agentIds]).toContain("agent-other");
  });

  test("Writing a not-yet-existing file through a symlinked dir still resolves to the agent", () => {
    const home = makeTempHome();
    const otherMem = agentMemory(home, "agent-other");
    mkdirSync(otherMem, { recursive: true });
    const link = join(home, "link-to-other");
    symlinkSync(otherMem, link);

    const targets = extractTargetAgentPaths(
      "Write",
      { file_path: join(link, "implanted.md") }, // leaf does not exist yet
      home,
      {},
      home,
    );

    expect([...targets.agentIds]).toContain("agent-other");
  });

  test("a symlink from inside self's own memory into another agent is still caught", () => {
    const home = makeTempHome();
    const selfMem = agentMemory(home, "agent-self");
    const otherMem = agentMemory(home, "agent-other");
    mkdirSync(selfMem, { recursive: true });
    mkdirSync(otherMem, { recursive: true });
    writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");

    // The hole that a lexical-only check (or a realpath check skipped when the
    // lexical path already looks like self) would miss.
    const sneaky = join(selfMem, "sneaky");
    symlinkSync(otherMem, sneaky);

    const targets = extractTargetAgentPaths(
      "Read",
      { file_path: join(sneaky, "secret.md") },
      selfMem,
      {},
      home,
    );

    // Lexically this is agent-self (allowed); realpath reveals agent-other.
    expect([...targets.agentIds]).toContain("agent-self");
    expect([...targets.agentIds]).toContain("agent-other");
  });

  test("evaluateCrossAgentGuard denies a symlink escape end-to-end", () => {
    const home = makeTempHome();
    const otherMem = agentMemory(home, "agent-other");
    mkdirSync(otherMem, { recursive: true });
    writeFileSync(join(otherMem, "secret.md"), "TOPSECRET");
    const link = join(home, "escape");
    symlinkSync(otherMem, link);

    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: join(link, "secret.md") },
      home,
      {
        env: { HOME: home } as NodeJS.ProcessEnv,
        currentAgentId: "agent-self",
        disableMemoryGuard: false,
      },
    );

    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain("agent-other");
  });

  test("a plain (non-symlinked) path outside the tree is not a false positive", () => {
    const home = makeTempHome();
    const projectDir = join(home, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "notes.md"), "hi");

    const targets = extractTargetAgentPaths(
      "Read",
      { file_path: join(projectDir, "notes.md") },
      projectDir,
      {},
      home,
    );

    expect(targets.anyAgentScoped).toBe(false);
    expect([...targets.agentIds]).toHaveLength(0);
  });
});

describe("sandboxed subagent defers entirely to the kernel", () => {
  // A subagent confined as a whole process by the kernel sandbox (sentinel set)
  // gets cross-agent isolation enforced for every tool, so the guard skips.
  const subagentEnv = {
    LETTA_CODE_AGENT_ROLE: "subagent",
    LETTA_PARENT_AGENT_ID: "agent-parent",
  } as NodeJS.ProcessEnv;
  const crossAgentRead = { file_path: otherMemory("secret.md") };

  test("without the sandbox sentinel the guard still denies the cross-agent read", () => {
    const result = evaluateCrossAgentGuard("Read", crossAgentRead, "/tmp", {
      env: subagentEnv,
      currentAgentId: "agent-self",
    });
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });

  test("with the sentinel the guard defers (the kernel owns the whole process)", () => {
    const result = evaluateCrossAgentGuard("Read", crossAgentRead, "/tmp", {
      env: { ...subagentEnv, [SANDBOX_ENV_VAR]: "seatbelt" },
      currentAgentId: "agent-self",
    });
    expect(result).toBeNull();
  });
});

describe("local-backend memfs tree", () => {
  // Local-backend memory lives at ~/.letta/lc-local-backend/memfs/<id>/memory,
  // not ~/.letta/agents. The kernel sandbox confines local subagents and shells,
  // but the parent agent's in-process Read/Edit/Write never fork, so this guard
  // is their only cross-agent backstop on local too.
  const localMemfs = (id: string, rel = ""): string =>
    join(HOME, ".letta", "lc-local-backend", "memfs", id, "memory", rel);

  beforeEach(() => {
    cliPermissions.setMemoryGuardDisabled(false);
  });

  test("extractTargetAgentPaths attributes a local memfs path to its agent", () => {
    const result = extractTargetAgentPaths(
      "Write",
      { file_path: localMemfs(OTHER, "system/persona.md") },
      "/tmp",
    );
    expect(result.anyAgentScoped).toBe(true);
    expect(result.agentIds).toEqual(new Set([OTHER]));
  });

  test("Read of another local agent's memory is denied", () => {
    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: localMemfs(OTHER, "system/persona.md") },
      "/tmp",
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });

  test("own local memory passes", () => {
    process.env.AGENT_ID = SELF;
    const result = evaluateCrossAgentGuard(
      "Write",
      { file_path: localMemfs(SELF, "note.md") },
      "/tmp",
    );
    expect(result).toBeNull();
  });

  test("enumerating the local memfs tree root is denied", () => {
    const result = evaluateCrossAgentGuard(
      "ListDir",
      { path: join(HOME, ".letta", "lc-local-backend", "memfs") },
      "/tmp",
    );
    expect(result).not.toBeNull();
  });

  test("honors the LETTA_LOCAL_BACKEND_DIR storage override", () => {
    const customStorage = join(HOME, "custom-letta-store");
    const result = evaluateCrossAgentGuard(
      "Read",
      { file_path: join(customStorage, "memfs", OTHER, "memory", "x.md") },
      "/tmp",
      {
        env: {
          HOME,
          AGENT_ID: SELF,
          LETTA_LOCAL_BACKEND_DIR: customStorage,
        } as NodeJS.ProcessEnv,
        currentAgentId: SELF,
      },
    );
    expect(result).not.toBeNull();
    expect(result?.offendingAgentIds).toContain(OTHER);
  });
});

// ---------------------------------------------------------------------------
// Toolset alignment: the guard covers Codex/Gemini file tools (not just Claude)
// on BOTH the API and local trees. Tool names are canonicalized; path args
// converge on file_path / path / notebook_path / dir_path / patch input.
// ---------------------------------------------------------------------------

describe("toolset alignment (Codex / Gemini file tools)", () => {
  const localMemfs = (id: string, rel = ""): string =>
    join(HOME, ".letta", "lc-local-backend", "memfs", id, "memory", rel);

  beforeEach(() => {
    cliPermissions.setMemoryGuardDisabled(false);
  });

  // [toolName, args] pairs that each target OTHER's memory, for both trees.
  const cases: Array<[string, (target: string) => Record<string, unknown>]> = [
    ["read_file_gemini", (t) => ({ file_path: t })],
    ["write_file_gemini", (t) => ({ file_path: t })],
    ["replace", (t) => ({ file_path: t })], // Gemini edit
    ["read_file", (t) => ({ file_path: t })], // Codex read
    ["list_directory", (t) => ({ dir_path: t })], // Gemini list (dir_path!)
    ["glob_gemini", (t) => ({ pattern: "**/*.md", dir_path: t })],
    ["search_file_content", (t) => ({ pattern: "secret", dir_path: t })],
    [
      "apply_patch",
      (t) => ({
        input: `*** Begin Patch\n*** Update File: ${t}\n*** End Patch`,
      }),
    ],
  ];

  for (const [toolName, makeArgs] of cases) {
    test(`${toolName} → another agent's API memory is denied`, () => {
      const result = evaluateCrossAgentGuard(
        toolName,
        makeArgs(otherMemory("system/persona.md")),
        "/tmp",
      );
      expect(result).not.toBeNull();
      expect(result?.offendingAgentIds).toContain(OTHER);
    });

    test(`${toolName} → another agent's LOCAL memory is denied`, () => {
      const result = evaluateCrossAgentGuard(
        toolName,
        makeArgs(localMemfs(OTHER, "system/persona.md")),
        "/tmp",
      );
      expect(result).not.toBeNull();
      expect(result?.offendingAgentIds).toContain(OTHER);
    });
  }
});
