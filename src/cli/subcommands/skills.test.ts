import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSkillDirectory,
  downloadDirectSkillFileSource,
  installSkillDirectory,
  listSkillDirectories,
  MAX_DIRECT_SKILL_FILE_BYTES,
  parseClawHubSpecifier,
  parseDirectSkillFileUrlSpecifier,
  parseGitHubSpecifier,
  syncCommittedRemoteSkillMemoryChange,
} from "./skills";

describe("skills subcommand", () => {
  test("parses GitHub tree URLs", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/tree/main/path/to/skill",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("parses GitHub blob SKILL.md URLs as their containing skill directory", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/blob/main/path/to/skill/SKILL.md",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("does not parse non-GitHub absolute URLs as GitHub shorthand", () => {
    expect(parseGitHubSpecifier("https://docs.x.com/skill.md")).toBeNull();
    expect(parseGitHubSpecifier("https://docs.x.com/not-a-skill")).toBeNull();
  });

  test("parses direct HTTPS skill file URLs", () => {
    expect(
      parseDirectSkillFileUrlSpecifier(
        "https://docs.x.com/path/skill.md?download=1",
      ),
    ).toEqual({
      url: "https://docs.x.com/path/skill.md?download=1",
    });
    expect(
      parseDirectSkillFileUrlSpecifier("https://docs.x.com/path/SKILL.md"),
    ).toEqual({
      url: "https://docs.x.com/path/SKILL.md",
    });
    expect(
      parseDirectSkillFileUrlSpecifier("https://docs.x.com/path/readme.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("https://user:pass@docs.x.com/SKILL.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("http://docs.x.com/SKILL.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("http://localhost:3000/SKILL.md"),
    ).toEqual({
      url: "http://localhost:3000/SKILL.md",
    });
  });

  test("parses ClawHub specifiers", () => {
    expect(parseClawHubSpecifier("clawhub/nano-banana-pro")).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
    expect(parseClawHubSpecifier("clawhub:nano-banana-pro@1.0.1")).toEqual({
      slug: "nano-banana-pro",
      version: "1.0.1",
    });
    expect(
      parseClawHubSpecifier("https://clawhub.ai/skills/nano-banana-pro"),
    ).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
  });

  test("installs a skill directory into memfs skills using frontmatter name", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const sourceDir = join(tempRoot, "source", "finance", "stocks");
      const memoryDir = join(tempRoot, "memory");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      writeFileSync(
        join(sourceDir, "SKILL.md"),
        "---\nname: market-data\ndescription: test\n---\n\n# Market Data\n",
      );
      writeFileSync(join(sourceDir, "scripts", "client.py"), "print('ok')\n");

      const result = await installSkillDirectory({ sourceDir, memoryDir });

      expect(result.name).toBe("market-data");
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toContain(
        "# Market Data",
      );
      expect(
        await readFile(join(result.path, "scripts", "client.py"), "utf8"),
      ).toBe("print('ok')\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("downloads a direct skill file URL as a skill directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    let downloaded: { tmpDir: string; sourceDir: string } | null = null;
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillText =
        "---\nname: direct-url\ndescription: test\n---\n\n# Direct URL\n";

      downloaded = await downloadDirectSkillFileSource(
        { url: "https://docs.x.com/SKILL.md" },
        {
          fetchImpl: async (url) => {
            expect(String(url)).toBe("https://docs.x.com/SKILL.md");
            return new Response(skillText, {
              headers: { "content-length": String(skillText.length) },
            });
          },
        },
      );

      const result = await installSkillDirectory({
        sourceDir: downloaded.sourceDir,
        memoryDir,
      });

      expect(result.name).toBe("direct-url");
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toBe(
        skillText,
      );
    } finally {
      if (downloaded) {
        await rm(downloaded.tmpDir, { recursive: true, force: true });
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects oversized direct skill file downloads", async () => {
    await expect(
      downloadDirectSkillFileSource(
        { url: "https://docs.x.com/SKILL.md" },
        {
          fetchImpl: async () =>
            new Response("too large", {
              headers: {
                "content-length": String(MAX_DIRECT_SKILL_FILE_BYTES + 1),
              },
            }),
        },
      ),
    ).rejects.toThrow(
      `Direct skill file exceeds ${MAX_DIRECT_SKILL_FILE_BYTES} byte limit.`,
    );
  });

  test("lists installed skill directories with frontmatter metadata", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillDir = join(memoryDir, "skills", "stocks");
      await mkdir(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: stocks\ndescription: Stock quotes\n---\n\n# Stocks\n",
      );

      expect(await listSkillDirectories({ memoryDir })).toEqual([
        {
          name: "stocks",
          description: "Stock quotes",
          path: skillDir,
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("deletes an installed skill directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillDir = join(memoryDir, "skills", "stocks");
      await mkdir(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Stocks\n");

      const result = await deleteSkillDirectory({ memoryDir, name: "stocks" });

      expect(result).toEqual({ name: "stocks", path: skillDir });
      expect(existsSync(skillDir)).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("syncs committed remote MemFS skill changes", async () => {
    const calls: Array<{ agentId: string; memoryDir?: string }> = [];

    const result = await syncCommittedRemoteSkillMemoryChange({
      agentId: "agent-123",
      memoryDir: "/tmp/memory",
      committed: true,
      syncFn: async (agentId, options) => {
        calls.push({ agentId, memoryDir: options.memoryDir });
        return {
          status: "pushed" as const,
          summary: "Pushed 1 pending memory commit(s).",
          memoryDir: options.memoryDir ?? "",
          localOnly: false,
        };
      },
    });

    expect(calls).toEqual([{ agentId: "agent-123", memoryDir: "/tmp/memory" }]);
    expect(result).toEqual({
      status: "pushed",
      summary: "Pushed 1 pending memory commit(s).",
    });
  });

  test("skips skill MemFS sync without a committed remote change", async () => {
    let calls = 0;
    const syncFn = async () => {
      calls += 1;
      return {
        status: "pushed" as const,
        summary: "should not run",
        memoryDir: "/tmp/memory",
        localOnly: false,
      };
    };

    await expect(
      syncCommittedRemoteSkillMemoryChange({
        agentId: "agent-123",
        memoryDir: "/tmp/memory",
        committed: false,
        syncFn,
      }),
    ).resolves.toBeUndefined();
    await expect(
      syncCommittedRemoteSkillMemoryChange({
        agentId: "agent-local-123",
        memoryDir: "/tmp/memory",
        committed: true,
        syncFn,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test("reports skill MemFS sync failures without failing the committed change", async () => {
    const result = await syncCommittedRemoteSkillMemoryChange({
      agentId: "agent-123",
      memoryDir: "/tmp/memory",
      committed: true,
      syncFn: async () => {
        throw new Error("push unavailable");
      },
    });

    expect(result).toEqual({
      status: "push_failed",
      summary: "push unavailable",
    });
  });
});
