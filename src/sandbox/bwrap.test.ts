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

test("memory mode binds root read-only (default-deny writes)", () => {
  const args = buildBwrapArgs(MEMORY_MODE);
  expect(tripleIndex(args, "--ro-bind", "/", "/")).toBe(0);
});

test("denied roots are masked with tmpfs", () => {
  const args = buildBwrapArgs(CROSS_AGENT);
  const tmpfsIdx = args.indexOf("--tmpfs");
  expect(tmpfsIdx).toBeGreaterThan(-1);
  expect(args[tmpfsIdx + 1]).toBe("/home/u/.letta/agents");
});

test("carveouts are restored after the tmpfs mask", () => {
  const args = buildBwrapArgs(CROSS_AGENT);
  const maskIdx = args.indexOf("--tmpfs");
  const writableIdx = tripleIndex(
    args,
    "--bind",
    "/home/u/.letta/agents/self",
    "/home/u/.letta/agents/self",
  );
  const readonlyIdx = tripleIndex(
    args,
    "--ro-bind",
    "/home/u/.letta/agents/parent",
    "/home/u/.letta/agents/parent",
  );
  expect(writableIdx).toBeGreaterThan(maskIdx);
  expect(readonlyIdx).toBeGreaterThan(maskIdx);
});

test("network is not unshared and parent death tears down the sandbox", () => {
  const args = buildBwrapArgs(MEMORY_MODE);
  expect(args).not.toContain("--unshare-net");
  expect(args).toContain("--die-with-parent");
});
