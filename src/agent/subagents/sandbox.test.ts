import { expect, test } from "bun:test";

import {
  type WrapSubagentLauncherInput,
  wrapSubagentLauncher,
} from "@/agent/subagents/sandbox";
import { getLocalBackendCrossAgentTreeRoot } from "@/backend/local/paths";
import {
  canonicalizeRoot,
  getDefaultAgentsTreeRoot,
} from "@/permissions/sandbox-policy";
import {
  isFsSandboxEnabled,
  isShellSandboxEnabled,
  type SandboxAvailability,
} from "@/sandbox/availability";
import { SANDBOX_ENV_VAR } from "@/sandbox/policy";
import { SANDBOX_EXEC_PATH } from "@/sandbox/seatbelt";

const SEATBELT: SandboxAvailability = {
  backend: "seatbelt",
  reason: "test",
};

const LAUNCHER = {
  command: "bun",
  args: ["run", "src/index.ts", "--headless"],
};

function baseInput(): WrapSubagentLauncherInput {
  return {
    launcher: LAUNCHER,
    launchProfile: "memory-subagent",
    backendMode: "api",
    memoryRoots: ["/home/u/.letta/agents/parent/memory"],
    inheritedPrimaryRoot: "/home/u/.letta/agents/parent/memory",
    env: { LETTA_FS_SANDBOX: "1" } as NodeJS.ProcessEnv,
    availability: SEATBELT,
  };
}

function defineValues(args: string[], prefix: string): string[] {
  return args
    .filter((a) => a.startsWith(prefix))
    .map((a) => a.slice(prefix.length));
}

test("isFsSandboxEnabled is on by default and only an explicit off-switch disables it", () => {
  // Default on (unset / empty).
  expect(isFsSandboxEnabled({})).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "" })).toBe(true);
  // Explicit on values still on.
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "1" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "true" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "TRUE" })).toBe(true);
  // Only the off-switch turns it off.
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "0" })).toBe(false);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "false" })).toBe(false);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "FALSE" })).toBe(false);
});

test("isShellSandboxEnabled is off by default and only an explicit on-switch enables it", () => {
  // Default off (unset / empty): only memory subagents are sandboxed.
  expect(isShellSandboxEnabled({})).toBe(false);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "" })).toBe(false);
  // Explicit off values stay off.
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "0" })).toBe(false);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "false" })).toBe(false);
  // Only the on-switch turns it on.
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "1" })).toBe(true);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "true" })).toBe(true);
  expect(isShellSandboxEnabled({ LETTA_FS_SANDBOX: "TRUE" })).toBe(true);
});

test("wraps an API subagent with the memory-subagent profile under the backend", () => {
  const result = wrapSubagentLauncher(baseInput());
  expect(result).not.toBeNull();
  expect(result?.command).toBe(SANDBOX_EXEC_PATH);
  // Original launcher survives intact after the -- separator.
  const sep = result?.args.indexOf("--") ?? -1;
  expect(sep).toBeGreaterThan(0);
  expect(result?.args.slice(sep + 1)).toEqual([
    "bun",
    "run",
    "src/index.ts",
    "--headless",
  ]);
  expect(result?.sandboxEnv[SANDBOX_ENV_VAR]).toBe("seatbelt");
  expect(result?.backend).toBe("seatbelt");
  expect(defineValues(result?.args ?? [], "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(getLocalBackendCrossAgentTreeRoot())}`,
  ]);
});

test("returns null when the flag is off", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), env: { LETTA_FS_SANDBOX: "0" } }),
  ).toBeNull();
});

test("returns null for non-memory-subagent launch profiles", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), launchProfile: "default" }),
  ).toBeNull();
  expect(
    wrapSubagentLauncher({ ...baseInput(), launchProfile: undefined }),
  ).toBeNull();
});

test("wraps a LOCAL subagent with the memory-subagent profile (deny-list against the memfs tree)", () => {
  const storageDir = "/home/u/.letta/lc-local-backend";
  const memoryRoot = `${storageDir}/memfs/parent/memory`;
  const result = wrapSubagentLauncher({
    ...baseInput(),
    backendMode: "local",
    memoryRoots: [memoryRoot],
    inheritedPrimaryRoot: memoryRoot,
    localBackendStorageDir: storageDir,
  });
  // Local is no longer skipped: the child is confined under the backend, with
  // its policy keyed to the memfs tree (asserted in sandbox-policy.test.ts).
  expect(result).not.toBeNull();
  expect(result?.command).toBe(SANDBOX_EXEC_PATH);
  expect(result?.sandboxEnv[SANDBOX_ENV_VAR]).toBe("seatbelt");
  expect(defineValues(result?.args ?? [], "-DDENIED_")).toEqual([
    `0=${getDefaultAgentsTreeRoot()}`,
    `1=${canonicalizeRoot(getLocalBackendCrossAgentTreeRoot(storageDir))}`,
  ]);
});

test("returns null when no sandbox backend is available", () => {
  expect(
    wrapSubagentLauncher({
      ...baseInput(),
      availability: { backend: null, reason: "none" },
    }),
  ).toBeNull();
});

test("returns null when there are no memory roots to scope to", () => {
  expect(
    wrapSubagentLauncher({
      ...baseInput(),
      memoryRoots: [],
      inheritedPrimaryRoot: null,
    }),
  ).toBeNull();
});

test("memoryScope confines a reflection subagent to an exact worktree plus git metadata", () => {
  const result = wrapSubagentLauncher({
    ...baseInput(),
    memoryScope: {
      primaryRoot: "/home/u/.letta/agents/parent/memory-worktrees/reflection-1",
      writableRoots: [
        "/home/u/.letta/agents/parent/memory-worktrees/reflection-1",
        "/home/u/.letta/agents/parent/memory/.git",
      ],
      readonlyRoots: ["/home/u/.letta/agents/parent"],
    },
  });

  expect(result).not.toBeNull();
  expect(defineValues(result?.args ?? [], "-DWRITABLE_")).toEqual([
    `0=${canonicalizeRoot("/home/u/.letta/agents/parent/memory-worktrees/reflection-1")}`,
    `1=${canonicalizeRoot("/home/u/.letta/agents/parent/memory/.git")}`,
  ]);
  expect(
    defineValues(result?.args ?? [], "-DREADONLY_").map((value) =>
      value.replace(/^\d+=/, ""),
    ),
  ).toContain(canonicalizeRoot("/home/u/.letta/agents/parent"));
});
