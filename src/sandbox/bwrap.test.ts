import { expect, test } from "bun:test";

import { buildBwrapArgs } from "@/sandbox/bwrap";
import { buildFsSandboxPolicy } from "@/sandbox/policy";

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

const LETTA_SCOPED = buildFsSandboxPolicy({
  baseWritableRoots: ["/home/u/.letta"],
  deniedRoots: ["/home/u/.letta/agents"],
  readonlyRoots: ["/home/u/.letta/agents/self"],
  writableRoots: ["/home/u/.letta/agents/self/memory"],
  restrictWrites: true,
});

const NESTED_DENY = buildFsSandboxPolicy({
  deniedRoots: [
    "/home/u/.letta/agents",
    "/home/u/.letta/agents/self/memory/local-store/memfs",
  ],
  writableRoots: [
    "/home/u/.letta/agents/self",
    "/home/u/.letta/agents/self/memory/local-store/memfs/self/memory",
  ],
  restrictWrites: false,
});

const NESTED_READONLY = buildFsSandboxPolicy({
  readonlyRoots: ["/scope/locked"],
  writableRoots: ["/scope", "/scope/locked/open"],
});

/** Find the index of a flag+operands triple in the bwrap arg list. */
function tripleIndex(args: string[], flag: string, a: string, b: string) {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
  }
  return -1;
}

test("cross-agent mode binds root read-write", () => {
  const args = buildBwrapArgs(CROSS_AGENT);
  expect(tripleIndex(args, "--bind", "/", "/")).toBe(0);
});

test("write-scoped profile binds root read-only (default-deny writes)", () => {
  const args = buildBwrapArgs(MEMORY_MODE);
  expect(tripleIndex(args, "--ro-bind", "/", "/")).toBe(0);
});

test("denied roots are masked with tmpfs", () => {
  const args = buildBwrapArgs(CROSS_AGENT);
  const tmpfsIdx = args.indexOf("--tmpfs");
  expect(tmpfsIdx).toBeGreaterThan(-1);
  expect(args[tmpfsIdx + 1]).toBe("/home/u/.letta/agents");
});

test("carveouts are restored after the tmpfs mask (with -try so missing roots don't abort the spawn)", () => {
  const args = buildBwrapArgs(CROSS_AGENT);
  const maskIdx = args.indexOf("--tmpfs");
  const writableIdx = tripleIndex(
    args,
    "--bind-try",
    "/home/u/.letta/agents/self",
    "/home/u/.letta/agents/self",
  );
  const readonlyIdx = tripleIndex(
    args,
    "--ro-bind-try",
    "/home/u/.letta/agents/parent",
    "/home/u/.letta/agents/parent",
  );
  expect(writableIdx).toBeGreaterThan(maskIdx);
  expect(readonlyIdx).toBeGreaterThan(maskIdx);
});

test("base writable is bound BEFORE the tmpfs mask, self memory after", () => {
  const args = buildBwrapArgs(LETTA_SCOPED);
  const base = tripleIndex(
    args,
    "--bind-try",
    "/home/u/.letta",
    "/home/u/.letta",
  );
  const mask = args.indexOf("--tmpfs");
  const self = tripleIndex(
    args,
    "--bind-try",
    "/home/u/.letta/agents/self/memory",
    "/home/u/.letta/agents/self/memory",
  );
  expect(base).toBeGreaterThan(-1);
  // Base ~/.letta bound rw FIRST; the tmpfs mask runs AFTER so the nested
  // cross-agent tree is still masked (the ancestor carve is safe here)...
  expect(mask).toBeGreaterThan(base);
  // ...and self memory is re-bound AFTER the mask so it reappears.
  expect(self).toBeGreaterThan(mask);
});

test("nested deny ordering preserves a legitimate inner self carve", () => {
  const args = buildBwrapArgs(NESTED_DENY);
  const nested = "/home/u/.letta/agents/self/memory/local-store/memfs";
  const nestedMask = args.findIndex(
    (arg, index) => arg === "--tmpfs" && args[index + 1] === nested,
  );
  const outerSelf = tripleIndex(
    args,
    "--bind-try",
    "/home/u/.letta/agents/self",
    "/home/u/.letta/agents/self",
  );
  const innerSelf = tripleIndex(
    args,
    "--bind-try",
    `${nested}/self/memory`,
    `${nested}/self/memory`,
  );

  expect(nestedMask).toBeGreaterThan(outerSelf);
  expect(innerSelf).toBeGreaterThan(nestedMask);
});

test("readonly child overrides writable parent before inner writable restore", () => {
  const args = buildBwrapArgs(NESTED_READONLY);
  const outerWritable = tripleIndex(args, "--bind-try", "/scope", "/scope");
  const readonlyChild = tripleIndex(
    args,
    "--ro-bind-try",
    "/scope/locked",
    "/scope/locked",
  );
  const innerWritable = tripleIndex(
    args,
    "--bind-try",
    "/scope/locked/open",
    "/scope/locked/open",
  );

  expect(readonlyChild).toBeGreaterThan(outerWritable);
  expect(innerWritable).toBeGreaterThan(readonlyChild);
});

test("network is not unshared and parent death tears down the sandbox", () => {
  const args = buildBwrapArgs(MEMORY_MODE);
  expect(args).not.toContain("--unshare-net");
  expect(args).toContain("--die-with-parent");
});
