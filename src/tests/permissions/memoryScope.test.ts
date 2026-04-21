import { afterEach, expect, test } from "bun:test";

import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { cliPermissions } from "../../permissions/cli";
import {
  normalizeScopedPath,
  resolveAllowedMemoryRoots,
} from "../../permissions/memoryScope";

afterEach(() => {
  delete process.env.MEMORY_DIR;
  delete process.env.LETTA_MEMORY_DIR;
  delete process.env.LETTA_MEMORY_SCOPE;
  delete process.env.AGENT_ID;
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_PARENT_AGENT_ID;
  cliPermissions.clear();
});

test("explicit env roots are authoritative over fallback inference", () => {
  process.env.MEMORY_DIR = "/tmp/explicit-memory";
  process.env.LETTA_MEMORY_SCOPE = "agent-parent-in-scope";
  process.env.AGENT_ID = "agent-fallback";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent-fallback";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });
  const scopedParentRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-parent-in-scope", "/Users/test"),
  );

  expect(scope.usedFallback).toBe(false);
  expect(scope.primaryRoot).toBe(normalizeScopedPath("/tmp/explicit-memory"));
  expect(scope.roots).toContain(normalizeScopedPath("/tmp/explicit-memory"));
  // Parent's memory root is derived from LETTA_MEMORY_SCOPE agent IDs.
  expect(scope.roots).toContain(scopedParentRoot);
  expect(scope.roots).not.toContain(
    normalizeScopedPath(
      getMemoryFilesystemRoot("agent-fallback", "/Users/test"),
    ),
  );
});

test("LETTA_MEMORY_SCOPE contributes parent roots alongside MEMORY_DIR", () => {
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-self/memory";
  process.env.LETTA_MEMORY_SCOPE = "agent-alpha,agent-beta";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });
  const alphaRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-alpha", "/Users/test"),
  );
  const betaRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-beta", "/Users/test"),
  );

  expect(scope.roots).toContain(alphaRoot);
  expect(scope.roots).toContain(betaRoot);
});

test("--memory-scope CLI flag also contributes roots", () => {
  process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-self/memory";
  cliPermissions.setMemoryScope("agent-from-cli");

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });
  const cliRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-from-cli", "/Users/test"),
  );

  expect(scope.roots).toContain(cliRoot);
});

test("falls back to agent-derived roots when no explicit env roots exist", () => {
  process.env.AGENT_ID = "agent-self";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });
  const selfRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-self", "/Users/test"),
  );
  const parentRoot = normalizeScopedPath(
    getMemoryFilesystemRoot("agent-parent", "/Users/test"),
  );

  expect(scope.usedFallback).toBe(true);
  expect(scope.primaryRoot).toBe(selfRoot);
  expect(scope.roots).toContain(selfRoot);
  expect(scope.roots).toContain(parentRoot);
});
