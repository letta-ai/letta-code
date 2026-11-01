import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLocalMemoryRepo } from "@/agent/memory-git";
import { applyPersonalityToMemory } from "@/agent/personality";
import { getPersonalityContent } from "@/agent/personality-presets";
import { configureBackendMode } from "@/backend";

/**
 * Runs applyPersonalityToMemory against real local memory repos (with the
 * real pre-commit validator) for the v2 root layout and the legacy layout.
 */

const AGENT_ID = "agent-local-personality-memory-test";
const ROOT_PERSONA =
  "---\nname: Persona\ndescription: Who I am\n---\n\nOld persona.\n";
const ROOT_HUMAN =
  "---\nname: Human\ndescription: Who the user is\n---\n\nOld human.\n";
const MEMORY_INDEX = "# Memory\n\n- persona.md\n- human.md\n";

let tempDir: string;
let memoryDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: memoryDir, encoding: "utf8" });
}

function read(relativePath: string): string {
  return readFileSync(join(memoryDir, relativePath), "utf8");
}

async function initRepo(
  files: Array<{ relativePath: string; content: string }>,
): Promise<void> {
  await initializeLocalMemoryRepo({ memoryDir, agentId: AGENT_ID, files });
  expect(git("status", "--porcelain")).toBe("");
}

/** Commit a validator config directly; the hook protects it from agents. */
function commitConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(memoryDir, ".memfs.config.json"),
    JSON.stringify(config),
    "utf8",
  );
  git("add", ".memfs.config.json");
  git("commit", "--no-verify", "-q", "-m", "test: add memory limits");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "personality-memory-"));
  const globalConfigPath = join(tempDir, "gitconfig");
  writeFileSync(globalConfigPath, "", "utf8");
  setEnv("GIT_CONFIG_GLOBAL", globalConfigPath);
  setEnv("LETTA_LOCAL_BACKEND_EXPERIMENTAL", "1");
  setEnv("LETTA_LOCAL_BACKEND_DIR", join(tempDir, "backend"));
  memoryDir = join(tempDir, "backend", "memfs", AGENT_ID, "memory");
  configureBackendMode("local");
});

afterEach(() => {
  configureBackendMode("api");
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("applyPersonalityToMemory", () => {
  test("root-layout repo updates root persona.md/human.md and commits", async () => {
    await initRepo([
      { relativePath: "MEMORY.md", content: MEMORY_INDEX },
      { relativePath: "persona.md", content: ROOT_PERSONA },
      { relativePath: "human.md", content: ROOT_HUMAN },
    ]);
    const headBefore = git("rev-parse", "HEAD").trim();

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "linus",
    });

    expect(result.changed).toBe(true);
    expect(result.personaRelativePath).toBe("persona.md");
    expect(result.humanRelativePath).toBe("human.md");
    expect(existsSync(join(memoryDir, "system"))).toBe(false);
    expect(read("persona.md")).toContain("name: Persona");
    expect(read("persona.md")).toContain(
      getPersonalityContent("linus").trim().split("\n")[0] ?? "",
    );
    expect(read("persona.md")).not.toContain("Old persona.");
    expect(git("rev-parse", "HEAD").trim()).not.toBe(headBefore);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("root-layout repo creates missing root files with v2 frontmatter", async () => {
    await initRepo([
      { relativePath: "MEMORY.md", content: MEMORY_INDEX },
      { relativePath: "persona.md", content: ROOT_PERSONA },
    ]);

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "linus",
    });

    expect(result.changed).toBe(true);
    expect(result.humanRelativePath).toBe("human.md");
    expect(read("human.md")).toMatch(
      /^---\n(?:name: Human\ndescription: .+|description: .+\nname: Human)\n---\n/,
    );
    expect(existsSync(join(memoryDir, "system"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("legacy repo keeps writing system/persona.md and system/human.md", async () => {
    await initRepo([
      {
        relativePath: "system/persona.md",
        content: "---\ndescription: Who I am\n---\n\nOld persona.\n",
      },
      {
        relativePath: "system/human.md",
        content: "---\ndescription: Who the user is\n---\n\nOld human.\n",
      },
    ]);

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "linus",
    });

    expect(result.changed).toBe(true);
    expect(result.personaRelativePath).toBe("system/persona.md");
    expect(result.humanRelativePath).toBe("system/human.md");
    expect(existsSync(join(memoryDir, "persona.md"))).toBe(false);
    expect(read("system/persona.md")).not.toContain("Old persona.");
    expect(git("status", "--porcelain")).toBe("");
  });

  test("rejected commit restores modified files and removes created ones", async () => {
    await initRepo([
      { relativePath: "MEMORY.md", content: MEMORY_INDEX },
      { relativePath: "persona.md", content: ROOT_PERSONA },
    ]);
    commitConfig({
      version: 1,
      fileCharacterLimits: [{ pattern: "human.md", maxCharacters: 10 }],
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await applyPersonalityToMemory({
        agentId: AGENT_ID,
        personalityId: "linus",
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("uncommitted changes");
      expect(git("status", "--porcelain")).toBe("");
      expect(read("persona.md")).toBe(ROOT_PERSONA);
      expect(existsSync(join(memoryDir, "human.md"))).toBe(false);
    }
  });

  test("rejected commit removes directories the switch created", async () => {
    await initRepo([]);
    commitConfig({ version: 1, maxFileCharacters: 10 });

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await applyPersonalityToMemory({
        agentId: AGENT_ID,
        personalityId: "linus",
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("uncommitted changes");
      expect(existsSync(join(memoryDir, "system"))).toBe(false);
      expect(git("status", "--porcelain")).toBe("");
    }
  });
});
