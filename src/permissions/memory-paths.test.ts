import { afterEach, expect, test } from "bun:test";

import { getMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  normalizeMemoryPath,
  resolveAllowedMemoryRoots,
} from "@/permissions/memory-paths";

afterEach(() => {
  delete process.env.MEMORY_DIR;
  delete process.env.LETTA_MEMORY_DIR;
  delete process.env.AGENT_ID;
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_PARENT_AGENT_ID;
  delete process.env.LETTA_CODE_AGENT_ROLE;
});

test("explicit env roots are authoritative over fallback inference", () => {
  process.env.MEMORY_DIR = "/tmp/explicit-memory";
  process.env.AGENT_ID = "agent-fallback";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent-fallback";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });

  expect(scope.usedFallback).toBe(false);
  expect(scope.primaryRoot).toBe(normalizeMemoryPath("/tmp/explicit-memory"));
  expect(scope.roots).toContain(normalizeMemoryPath("/tmp/explicit-memory"));
  expect(scope.roots).not.toContain(
    normalizeMemoryPath(
      getMemoryFilesystemRoot("agent-fallback", "/Users/test"),
    ),
  );
});

test("falls back to agent-derived roots when no explicit env roots exist", () => {
  process.env.AGENT_ID = "agent-self";
  process.env.LETTA_PARENT_AGENT_ID = "agent-parent";
  process.env.LETTA_CODE_AGENT_ROLE = "subagent";

  const scope = resolveAllowedMemoryRoots({ homeDir: "/Users/test" });
  const selfRoot = normalizeMemoryPath(
    getMemoryFilesystemRoot("agent-self", "/Users/test"),
  );
  const parentRoot = normalizeMemoryPath(
    getMemoryFilesystemRoot("agent-parent", "/Users/test"),
  );

  expect(scope.usedFallback).toBe(true);
  expect(scope.primaryRoot).toBe(selfRoot);
  expect(scope.roots).toContain(selfRoot);
  expect(scope.roots).toContain(parentRoot);
});
