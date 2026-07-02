import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { willSandboxShell } from "@/permissions/sandbox-gate";
import type { SandboxAvailability } from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { getLocalBackendCrossAgentTreeRoot } from "@/utils/local-backend-paths";

const SEATBELT: SandboxAvailability = { backend: "seatbelt", reason: "test" };
const NO_BACKEND: SandboxAvailability = { backend: null, reason: "test" };
const REPO_CWD = process.cwd();
const MEM = "/tmp/willsandbox/memory";

test("false when the flag is off (no host probe needed)", () => {
  expect(willSandboxShell(REPO_CWD, {}, SEATBELT)).toBe(false);
});

test("false when already inside a sandbox", () => {
  const env = {
    LETTA_FS_SANDBOX: "1",
    [SANDBOX_ENV_VAR]: "seatbelt",
    MEMORY_DIR: MEM,
  };
  expect(willSandboxShell(REPO_CWD, env, SEATBELT)).toBe(false);
});

test("true for an unsandboxed subagent process", () => {
  const env = {
    LETTA_FS_SANDBOX: "1",
    LETTA_CODE_AGENT_ROLE: "subagent",
    MEMORY_DIR: MEM,
  };
  expect(willSandboxShell(REPO_CWD, env, SEATBELT)).toBe(true);
});

test("false for an already sandboxed subagent process", () => {
  const env = {
    LETTA_FS_SANDBOX: "1",
    LETTA_CODE_AGENT_ROLE: "subagent",
    [SANDBOX_ENV_VAR]: "bwrap",
    MEMORY_DIR: MEM,
  };
  expect(willSandboxShell(REPO_CWD, env, SEATBELT)).toBe(false);
});

test("false when no backend is available", () => {
  const env = { LETTA_FS_SANDBOX: "1", MEMORY_DIR: MEM };
  expect(willSandboxShell(REPO_CWD, env, NO_BACKEND)).toBe(false);
});

test("false when cwd is inside the agents tree", () => {
  const cwdInTree = join(homedir(), ".letta", "agents", "self", "memory");
  const env = { LETTA_FS_SANDBOX: "1", MEMORY_DIR: cwdInTree };
  expect(willSandboxShell(cwdInTree, env, SEATBELT)).toBe(false);
});

test("false when local backend cwd is inside the memfs tree", () => {
  const storageDir = join(REPO_CWD, "custom-local-backend");
  const cwdInTree = join(
    getLocalBackendCrossAgentTreeRoot(storageDir),
    "self",
    "memory",
  );
  const env = {
    LETTA_FS_SANDBOX: "1",
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_LOCAL_BACKEND_DIR: storageDir,
    MEMORY_DIR: cwdInTree,
  };
  expect(willSandboxShell(cwdInTree, env, SEATBELT)).toBe(false);
});

test("false when api backend cwd is inside the local memfs tree", () => {
  const storageDir = join(REPO_CWD, "custom-local-backend");
  const cwdInTree = join(
    getLocalBackendCrossAgentTreeRoot(storageDir),
    "self",
    "memory",
  );
  const env = {
    LETTA_FS_SANDBOX: "1",
    LETTA_LOCAL_BACKEND_DIR: storageDir,
    MEMORY_DIR: join(homedir(), ".letta", "agents", "self", "memory"),
  };
  expect(willSandboxShell(cwdInTree, env, SEATBELT)).toBe(false);
});

test("true for a parent with the flag on, a backend, cwd outside the tree, and self roots", () => {
  const env = { LETTA_FS_SANDBOX: "1", MEMORY_DIR: MEM };
  expect(willSandboxShell(REPO_CWD, env, SEATBELT)).toBe(true);
});
