import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSubagentConfigCache,
  getAllSubagentConfigs,
} from "@/agent/subagents";
import { __testSetBackend, type Backend } from "@/backend";

let tempDir: string | null = null;

function createTempProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "letta-subagents-test-"));
}

function writeCustomSubagent(
  projectDir: string,
  fileName: string,
  content: string,
) {
  const agentsDir = join(projectDir, ".letta", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, fileName), content, "utf-8");
}

beforeEach(() => {
  __testSetBackend(null);
  clearSubagentConfigCache();
});

afterEach(() => {
  __testSetBackend(null);
  clearSubagentConfigCache();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("built-in subagents", () => {
  test("includes reflection subagent in available configs", async () => {
    const configs = await getAllSubagentConfigs();
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.name).toBe("reflection");
    expect(configs.reflection?.recommendedModel).toBe("inherit");
  });

  test("memory-related built-ins use memory permission mode", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.permissionMode).toBe("memory");
    expect(configs["history-analyzer"]?.permissionMode).toBe("memory");
    expect(configs.memory?.permissionMode).toBe("memory");
    expect(configs.init?.permissionMode).toBe("memory");
  });

  test("reflection exposes only Edit among first-class file tools", async () => {
    const configs = await getAllSubagentConfigs();
    const hiddenFileTools = ["Read", "Write", "Glob", "Grep"];

    expect(configs.reflection?.allowedTools).toContain("Edit");
    expect(configs.memory?.allowedTools).not.toContain("Edit");
    for (const tool of hiddenFileTools) {
      expect(configs.reflection?.allowedTools).not.toContain(tool);
      expect(configs.memory?.allowedTools).not.toContain(tool);
    }
  });

  test("parses subagent mode and defaults missing mode to stateful", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.mode).toBe("stateless");
    expect(configs["general-purpose"]?.mode).toBe("stateful");
    expect(configs.memory?.mode).toBe("stateful");
  });

  test("reuses MemFS built-in prompts when local backend is active", async () => {
    __testSetBackend({
      capabilities: { localMemfs: true },
    } as unknown as Backend);
    clearSubagentConfigCache();

    const configs = await getAllSubagentConfigs();

    expect(configs.init?.systemPrompt).toContain("Commit (1 bash call)");
    expect(configs.init?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).toContain(
      'WORKTREE_DIR="$MEMORY_DIR-worktrees"',
    );
    expect(configs.memory?.systemPrompt).not.toContain("git push");
    expect(configs.reflection?.systemPrompt).not.toContain("git push");
  });

  test("keeps API-backed built-in prompts free of local backend wording", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.init?.systemPrompt).toContain("Commit (1 bash call)");
    expect(configs.init?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).not.toContain("git push");
    expect(configs.reflection?.systemPrompt).not.toContain("git push");
    expect(configs.memory?.systemPrompt).not.toContain(
      "local backend git-backed memory filesystem",
    );
    expect(configs.reflection?.systemPrompt).not.toContain(
      "local backend memory filesystem",
    );
  });

  test("custom CRLF reflection override replaces built-in reflection", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      [
        "---",
        "name: reflection",
        "description: Custom reflection override",
        "tools: Read",
        "model: zaisigno/glm-5",
        "memoryBlocks: none",
        "---",
        "Custom prompt body",
      ].join("\r\n"),
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.description).toBe("Custom reflection override");
    expect(configs.reflection?.recommendedModel).toBe("zaisigno/glm-5");
  });

  test("blank model field falls back to inherit", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflection.md",
      `---
name: reflection
description: Custom reflection override
tools: Read
model:
memoryBlocks: none
---
Custom prompt body`,
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.recommendedModel).toBe("inherit");
  });

  test("frontmatter name remains override key (filename can differ)", async () => {
    tempDir = createTempProjectDir();
    writeCustomSubagent(
      tempDir,
      "reflector.md",
      `---
name: reflection
description: Custom reflection override from different filename
tools: Read
memoryBlocks: none
---
Custom prompt body`,
    );

    const configs = await getAllSubagentConfigs(tempDir);
    expect(configs.reflection).toBeDefined();
    expect(configs.reflection?.description).toBe(
      "Custom reflection override from different filename",
    );
  });
});
