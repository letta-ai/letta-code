import { expect, test } from "bun:test";

import {
  isFsSandboxEnabled,
  wrapSubagentLauncher,
} from "@/agent/subagents/sandbox";
import type { SandboxAvailability } from "@/sandbox/availability";
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

function baseInput() {
  return {
    launcher: LAUNCHER,
    permissionMode: "memory",
    backendMode: "api",
    memoryRoots: ["/home/u/.letta/agents/parent/memory"],
    inheritedPrimaryRoot: "/home/u/.letta/agents/parent/memory",
    env: { LETTA_FS_SANDBOX: "1" } as NodeJS.ProcessEnv,
    availability: SEATBELT,
  };
}

test("isFsSandboxEnabled honors 1/true and rejects everything else", () => {
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "1" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "true" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "TRUE" })).toBe(true);
  expect(isFsSandboxEnabled({ LETTA_FS_SANDBOX: "0" })).toBe(false);
  expect(isFsSandboxEnabled({})).toBe(false);
});

test("wraps a memory-mode API subagent under the backend", () => {
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
});

test("returns null when the flag is off", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), env: { LETTA_FS_SANDBOX: "0" } }),
  ).toBeNull();
});

test("returns null for non-memory permission modes", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), permissionMode: "acceptEdits" }),
  ).toBeNull();
  expect(
    wrapSubagentLauncher({ ...baseInput(), permissionMode: undefined }),
  ).toBeNull();
});

test("returns null for the local backend (deferred)", () => {
  expect(
    wrapSubagentLauncher({ ...baseInput(), backendMode: "local" }),
  ).toBeNull();
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
