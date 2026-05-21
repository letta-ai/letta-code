import { describe, expect, test } from "bun:test";
import {
  buildInitMessage,
  buildShallowInitPrompt,
} from "@/cli/helpers/init-command";

describe("init command helpers", () => {
  const baseArgs = {
    agentId: "test-agent",
    workingDirectory: "/tmp/test",
    memoryDir: "/tmp/test/.memory",
    gitIdentity: "Test User <test@example.com>",
    existingMemoryPaths: [] as string[],
    existingMemory: "",
    dirListing: "README.md\npackage.json\nsrc",
  };

  test("buildShallowInitPrompt includes pre-gathered context", () => {
    const prompt = buildShallowInitPrompt(baseArgs);
    expect(prompt).toContain("memory_dir: /tmp/test/.memory");
    expect(prompt).toContain("git_user: Test User");
    expect(prompt).toContain("## Project Structure");
    expect(prompt).toContain("## Existing Memory");
  });

  test("buildInitMessage includes memoryDir when provided", () => {
    const msg = buildInitMessage({
      gitContext: "## Git\nsome info",
      memoryDir: "/tmp/.memory",
    });
    expect(msg).toContain("Memory filesystem is enabled");
    expect(msg).toContain("/tmp/.memory");
    expect(msg).toContain("initializing-memory");
  });

  test("buildInitMessage works without memoryDir", () => {
    const msg = buildInitMessage({
      gitContext: "## Git\nsome info",
    });
    expect(msg).not.toContain("Memory filesystem");
    expect(msg).toContain("initializing-memory");
  });
});
