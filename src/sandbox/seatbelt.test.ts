import { expect, test } from "bun:test";

import { buildFsSandboxPolicy } from "@/sandbox/policy";
import {
  buildSeatbeltArgs,
  buildSeatbeltProfile,
  SANDBOX_EXEC_PATH,
} from "@/sandbox/seatbelt";

const CROSS_AGENT = buildFsSandboxPolicy({
  deniedRoots: ["/home/u/.letta/agents"],
  writableRoots: ["/home/u/.letta/agents/self"],
  readonlyRoots: ["/home/u/.letta/agents/parent"],
  restrictWrites: false,
});

const MEMORY_MODE = buildFsSandboxPolicy({
  deniedRoots: ["/home/u/.letta/agents"],
  writableRoots: ["/home/u/.letta/agents/self/memory", "/tmp"],
  restrictWrites: true,
});

test("profile is allow-default with a denied root walled off", () => {
  const { profile } = buildSeatbeltProfile(CROSS_AGENT);
  expect(profile).toContain("(version 1)");
  expect(profile).toContain("(allow default)");
  expect(profile).toContain(
    '(deny file-read* file-write* (subpath (param "DENIED_0")))',
  );
});

test("cross-agent profile has no global write-deny", () => {
  const { profile } = buildSeatbeltProfile(CROSS_AGENT);
  expect(profile).not.toContain('(deny file-write* (subpath "/"))');
});

test("writable and readonly carveouts are restored after the deny", () => {
  const { profile } = buildSeatbeltProfile(CROSS_AGENT);
  const denyIdx = profile.indexOf("(deny file-read* file-write*");
  const writableIdx = profile.indexOf(
    '(allow file-read* file-write* (subpath (param "WRITABLE_0")))',
  );
  const readonlyIdx = profile.indexOf(
    '(allow file-read* (subpath (param "READONLY_0")))',
  );
  // Last-match-wins: carveouts must come after the deny to take effect.
  expect(writableIdx).toBeGreaterThan(denyIdx);
  expect(readonlyIdx).toBeGreaterThan(denyIdx);
});

test("memory mode denies all writes but keeps /dev and restores writables", () => {
  const { profile } = buildSeatbeltProfile(MEMORY_MODE);
  const globalDenyIdx = profile.indexOf('(deny file-write* (subpath "/"))');
  const devIdx = profile.indexOf('(allow file-write* (subpath "/dev"))');
  const writableIdx = profile.indexOf(
    '(allow file-read* file-write* (subpath (param "WRITABLE_0")))',
  );
  expect(globalDenyIdx).toBeGreaterThan(-1);
  expect(devIdx).toBeGreaterThan(globalDenyIdx);
  // Writable roots restored after the global write-deny.
  expect(writableIdx).toBeGreaterThan(globalDenyIdx);
});

test("defines map every param referenced in the profile", () => {
  const { defines } = buildSeatbeltProfile(MEMORY_MODE);
  const names = defines.map((d) => d.name);
  expect(names).toContain("DENIED_0");
  expect(names).toContain("WRITABLE_0");
  expect(names).toContain("WRITABLE_1");
  expect(defines.find((d) => d.name === "WRITABLE_1")?.value).toBe("/tmp");
});

test("args carry the profile and -D defines for the inner launcher", () => {
  const args = buildSeatbeltArgs(MEMORY_MODE);
  expect(args[0]).toBe("-p");
  expect(args).toContain("-DDENIED_0=/home/u/.letta/agents");
  expect(args).toContain("-DWRITABLE_1=/tmp");
  // SANDBOX_EXEC_PATH itself is added by wrapLauncher, not here.
  expect(args).not.toContain(SANDBOX_EXEC_PATH);
});
