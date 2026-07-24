import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSubagentConfigCache,
  discoverSubagents,
  getAllSubagentConfigs,
} from "../../agent/subagents";

async function writeSubagent(
  directory: string,
  filename: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
You are ${name}.
`;
  await writeFile(join(directory, filename), content, "utf-8");
}

describe("subagent discovery", () => {
  const testDirs: string[] = [];

  afterEach(async () => {
    clearSubagentConfigCache();
    for (const dir of testDirs.splice(0, testDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discovers project subagents from .agents", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "letta-subagents-"));
    testDirs.push(projectDir);

    const uniqueName = `custom-agent-${Date.now()}`;
    await writeSubagent(
      join(projectDir, ".agents"),
      "custom.md",
      uniqueName,
      "project-level agent",
    );

    const { subagents } = await discoverSubagents(projectDir);
    const discovered = subagents.find((s) => s.name === uniqueName);
    expect(discovered).toBeDefined();
    expect(discovered?.description).toBe("project-level agent");
  });

  test(".agents overrides legacy .letta/agents with the same name", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "letta-subagents-"));
    testDirs.push(projectDir);

    const uniqueName = `override-agent-${Date.now()}`;
    await writeSubagent(
      join(projectDir, ".letta/agents"),
      "legacy.md",
      uniqueName,
      "legacy description",
    );
    await writeSubagent(
      join(projectDir, ".agents"),
      "project.md",
      uniqueName,
      "preferred description",
    );

    const configs = await getAllSubagentConfigs(projectDir);
    expect(configs[uniqueName]).toBeDefined();
    expect(configs[uniqueName]?.description).toBe("preferred description");
  });

  test("recursively discovers nested markdown files under .agents", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "letta-subagents-"));
    testDirs.push(projectDir);

    const uniqueName = `nested-agent-${Date.now()}`;
    await writeSubagent(
      join(projectDir, ".agents/team/research"),
      "nested.md",
      uniqueName,
      "nested description",
    );

    const { subagents } = await discoverSubagents(projectDir);
    expect(subagents.some((s) => s.name === uniqueName)).toBe(true);
  });

  test("follows symlinked directories under .agents", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "letta-subagents-"));
    const sharedDir = await mkdtemp(join(tmpdir(), "letta-shared-agents-"));
    testDirs.push(projectDir, sharedDir);

    const uniqueName = `symlink-agent-${Date.now()}`;
    await writeSubagent(
      sharedDir,
      "shared.md",
      uniqueName,
      "symlinked description",
    );

    const agentsDir = join(projectDir, ".agents");
    await mkdir(agentsDir, { recursive: true });
    await symlink(sharedDir, join(agentsDir, "shared"), "dir");

    const { subagents } = await discoverSubagents(projectDir);
    const discovered = subagents.find((s) => s.name === uniqueName);
    expect(discovered).toBeDefined();
    expect(discovered?.description).toBe("symlinked description");
  });
});
