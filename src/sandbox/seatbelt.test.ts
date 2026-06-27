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

// Writes scoped to ~/.letta: base carve, cross-agent tree denied inside it, self
// memory re-carved. The three must be emitted in nesting order to layer right.
const LETTA_SCOPED = buildFsSandboxPolicy({
  baseWritableRoots: ["/home/u/.letta"],
  deniedRoots: ["/home/u/.letta/agents"],
  readonlyRoots: ["/home/u/.letta/agents/self"],
  writableRoots: ["/home/u/.letta/agents/self/memory"],
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

test("write-scoped profile denies all writes but keeps /dev and restores writables", () => {
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

test("base writable is layered: after global write-deny, before the deny, self after", () => {
  const { profile } = buildSeatbeltProfile(LETTA_SCOPED);
  const globalDeny = profile.indexOf('(deny file-write* (subpath "/"))');
  const base = profile.indexOf(
    '(allow file-write* (subpath (param "BASEWRITABLE_0")))',
  );
  const deny = profile.indexOf(
    '(deny file-read* file-write* (subpath (param "DENIED_0")))',
  );
  const self = profile.indexOf(
    '(allow file-read* file-write* (subpath (param "WRITABLE_0")))',
  );
  expect(globalDeny).toBeGreaterThan(-1);
  // ~/.letta becomes writable AFTER the global write-deny...
  expect(base).toBeGreaterThan(globalDeny);
  // ...the cross-agent tree deny comes AFTER the base (so the nested tree wins)...
  expect(deny).toBeGreaterThan(base);
  // ...and self memory is re-carved AFTER the deny (so self wins again).
  expect(self).toBeGreaterThan(deny);
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
