import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeRoot,
  getDefaultAgentsTreeRoot,
} from "@/permissions/sandbox-policy";
import type { SandboxAvailability } from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { SANDBOX_EXEC_PATH } from "@/sandbox/seatbelt";
import { applyParentShellSandbox } from "@/tools/impl/shell-sandbox";

const SEATBELT: SandboxAvailability = { backend: "seatbelt", reason: "test" };
const NO_BACKEND: SandboxAvailability = { backend: null, reason: "test" };
const LAUNCHER = ["/bin/zsh", "-c", "echo hi"];
// The parent agent's cwd is the repo — outside ~/.letta/agents.
const REPO_CWD = process.cwd();

function defineValue(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

test("no-op when the flag is off", () => {
  const result = applyParentShellSandbox(LAUNCHER, REPO_CWD, {}, SEATBELT);
  expect(result.backend).toBeNull();
  expect(result.launcher).toBe(LAUNCHER);
});

test("no-op when already inside a sandbox (no nested sandbox-exec)", () => {
  const result = applyParentShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      [SANDBOX_ENV_VAR]: "seatbelt",
      MEMORY_DIR: "/tmp/x/memory",
    },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
  expect(result.launcher).toBe(LAUNCHER);
});

test("no-op for subagent processes (parent-only)", () => {
  const result = applyParentShellSandbox(
    LAUNCHER,
    REPO_CWD,
    {
      LETTA_FS_SANDBOX: "1",
      LETTA_CODE_AGENT_ROLE: "subagent",
      MEMORY_DIR: "/tmp/x/memory",
    },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
});

test("no-op when no sandbox backend is available", () => {
  const result = applyParentShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: "/tmp/x/memory" },
    NO_BACKEND,
  );
  expect(result.backend).toBeNull();
});

test("no-op when cwd is inside the agents tree (Seatbelt empty-env hazard)", () => {
  const cwdInTree = join(homedir(), ".letta", "agents", "self", "memory");
  const result = applyParentShellSandbox(
    LAUNCHER,
    cwdInTree,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: cwdInTree },
    SEATBELT,
  );
  expect(result.backend).toBeNull();
});

test("wraps a parent launcher: denies agents tree, carves self, sets sentinel", () => {
  const memDir = join(REPO_CWD, "nonexistent-mem", "memory");
  const result = applyParentShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: memDir },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  expect(result.launcher[0]).toBe(SANDBOX_EXEC_PATH);
  // The inner launcher is preserved verbatim at the tail, after the `--`.
  expect(result.launcher).toContain("--");
  expect(result.launcher.slice(-3)).toEqual(LAUNCHER);
  expect(result.env[SANDBOX_ENV_VAR]).toBe("seatbelt");

  expect(defineValue(result.launcher, "-DDENIED_0=")).toBe(
    getDefaultAgentsTreeRoot(),
  );
  expect(defineValue(result.launcher, "-DWRITABLE_0=")).toBe(
    canonicalizeRoot(memDir),
  );
});

test("carves the whole self agent dir for an in-tree memory root", () => {
  const agentDir = join(getDefaultAgentsTreeRoot(), "test-cross-agent-xyz");
  const memDir = join(
    homedir(),
    ".letta",
    "agents",
    "test-cross-agent-xyz",
    "memory",
  );
  const result = applyParentShellSandbox(
    LAUNCHER,
    REPO_CWD,
    { LETTA_FS_SANDBOX: "1", MEMORY_DIR: memDir },
    SEATBELT,
  );

  expect(result.backend).toBe("seatbelt");
  // Both the /memory root and its /memory-worktrees sibling collapse to the
  // single agent directory — so there is exactly one writable carve-out.
  const writables = result.launcher.filter((a) => a.startsWith("-DWRITABLE_"));
  expect(writables).toEqual([`-DWRITABLE_0=${agentDir}`]);
});
