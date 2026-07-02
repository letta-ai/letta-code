import { expect, test } from "bun:test";

import { buildFsSandboxPolicy, normalizeSandboxPath } from "@/sandbox/policy";

test("normalizeSandboxPath strips trailing slashes and forward-slashes", () => {
  expect(normalizeSandboxPath("/a/b/")).toBe("/a/b");
  expect(normalizeSandboxPath("/a/b///")).toBe("/a/b");
  expect(normalizeSandboxPath("/")).toBe("/");
});

test("normalizeSandboxPath anchors relative paths at root, never cwd", () => {
  // A malformed relative root must not silently scope to the working dir.
  expect(normalizeSandboxPath("relative/path")).toBe("/relative/path");
});

test("buildFsSandboxPolicy normalizes and dedupes each root set", () => {
  const policy = buildFsSandboxPolicy({
    deniedRoots: ["/home/u/.letta/agents/", "/home/u/.letta/agents"],
    writableRoots: ["/home/u/.letta/agents/self/memory/"],
    readonlyRoots: ["/home/u/.letta/agents/parent"],
    restrictWrites: true,
  });

  expect(policy.deniedRoots).toEqual(["/home/u/.letta/agents"]);
  expect(policy.writableRoots).toEqual(["/home/u/.letta/agents/self/memory"]);
  expect(policy.readonlyRoots).toEqual(["/home/u/.letta/agents/parent"]);
  expect(policy.restrictWrites).toBe(true);
});

test("buildFsSandboxPolicy drops empty/whitespace roots and defaults", () => {
  const policy = buildFsSandboxPolicy({
    deniedRoots: ["/agents", "", "   "],
  });

  expect(policy.deniedRoots).toEqual(["/agents"]);
  expect(policy.writableRoots).toEqual([]);
  expect(policy.readonlyRoots).toEqual([]);
  expect(policy.restrictWrites).toBe(false);
});
