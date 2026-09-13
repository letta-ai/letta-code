import { expect, test } from "bun:test";

import { buildFsSandboxPolicy } from "@/sandbox/policy";
import { SANDBOX_EXEC_PATH } from "@/sandbox/seatbelt";
import { wrapLauncher } from "@/sandbox/wrap";

const POLICY = buildFsSandboxPolicy({
  deniedRoots: ["/home/u/.letta/agents"],
  writableRoots: ["/home/u/.letta/agents/self"],
});

const LAUNCHER = ["/bin/zsh", "-c", "echo hi"];

test("returns null when no backend is available", () => {
  expect(wrapLauncher(LAUNCHER, POLICY, { backend: null })).toBeNull();
});

test("returns null for an empty launcher", () => {
  expect(wrapLauncher([], POLICY, { backend: "seatbelt" })).toBeNull();
});

test("seatbelt wrapping prepends sandbox-exec and ends with -- + launcher", () => {
  const wrapped = wrapLauncher(LAUNCHER, POLICY, { backend: "seatbelt" });
  expect(wrapped?.[0]).toBe(SANDBOX_EXEC_PATH);
  const sep = wrapped?.indexOf("--") ?? -1;
  expect(sep).toBeGreaterThan(0);
  expect(wrapped?.slice(sep + 1)).toEqual(LAUNCHER);
});

test("bwrap wrapping uses the resolved binary path and -- separator", () => {
  const wrapped = wrapLauncher(LAUNCHER, POLICY, {
    backend: "bwrap",
    bwrapPath: "/usr/bin/bwrap",
  });
  expect(wrapped?.[0]).toBe("/usr/bin/bwrap");
  const sep = wrapped?.indexOf("--") ?? -1;
  expect(wrapped?.slice(sep + 1)).toEqual(LAUNCHER);
});

test("bwrap wrapping defaults to bare 'bwrap' when no path given", () => {
  const wrapped = wrapLauncher(LAUNCHER, POLICY, { backend: "bwrap" });
  expect(wrapped?.[0]).toBe("bwrap");
});
