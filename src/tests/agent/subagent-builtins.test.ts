import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSubagentConfigCache,
  getAllSubagentConfigs,
} from "../../agent/subagents";

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
  clearSubagentConfigCache();
});

afterEach(() => {
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
  });

  test("memory-related built-ins use memory permission mode", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.permissionMode).toBe("memory");
    expect(configs["history-analyzer"]?.permissionMode).toBe("memory");
    expect(configs.memory?.permissionMode).toBe("memory");
    expect(configs.init?.permissionMode).toBe("memory");
  });

  test("parses subagent mode and defaults missing mode to stateful", async () => {
    const configs = await getAllSubagentConfigs();

    expect(configs.reflection?.mode).toBe("stateless");
    expect(configs["general-purpose"]?.mode).toBe("stateful");
    expect(configs.memory?.mode).toBe("stateful");
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
