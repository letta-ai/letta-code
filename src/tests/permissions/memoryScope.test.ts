import { afterEach, expect, test } from "bun:test";

import { resolveAllowedMemoryRoots } from "../../permissions/memoryScope";

afterEach(() => {
  delete process.env.MEMORY_DIR;
  delete process.env.LETTA_MEMORY_DIR;
  delete process.env.PARENT_MEMORY_DIR;
  delete process.env.AGENT_ID;
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_PARENT_AGENT_ID;
});

test("explicit env roots are authoritative over fallback inference", () => {
  process.env.MEMORY_DIR = "/tmp/explicit-memory";
  process.env.PARENT_MEMORY_DIR = "/tmp/explicit-parent-memory";
  process.env.AGENT_ID = "agent-fallback";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent-fallback";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });

  expect(scope.usedFallback).toBe(false);
  expect(scope.primaryRoot).toBe("/tmp/explicit-memory");
  expect(scope.roots).toContain("/tmp/explicit-memory");
  expect(scope.roots).toContain("/tmp/explicit-parent-memory");
  expect(scope.roots).not.toContain(
    "/Users/test/.letta/agents/agent-fallback/memory",
  );
});

test("falls back to agent-derived roots when no explicit env roots exist", () => {
  process.env.AGENT_ID = "agent-self";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });

  expect(scope.usedFallback).toBe(true);
  expect(scope.primaryRoot).toBe("/Users/test/.letta/agents/agent-self/memory");
  expect(scope.roots).toContain("/Users/test/.letta/agents/agent-self/memory");
  expect(scope.roots).toContain(
    "/Users/test/.letta/agents/agent-parent/memory",
  );
});
