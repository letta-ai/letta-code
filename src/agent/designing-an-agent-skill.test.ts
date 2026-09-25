import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPersonalityAssetPath } from "@/agent/personality-default-files";
import {
  getPersonalityDefaultMemoryFiles,
  PERSONALITY_OPTIONS,
} from "@/agent/personality-presets";
import { getBundledSkills } from "@/agent/skills";

const SKILL_PREFIX = "skills/designing-an-agent/";

/**
 * Resolve a seeded MemFS path through the real default-file wiring:
 * preset definition -> asset id -> bundled asset file on disk.
 */
function getTutorSkillFile(memfsPath: string): string {
  const file = getPersonalityDefaultMemoryFiles("tutorial").find(
    (candidate) => candidate.path === memfsPath,
  );
  if (!file) {
    throw new Error(`Tutor default file missing: ${memfsPath}`);
  }
  return readFileSync(getPersonalityAssetPath(file.assetId), "utf-8");
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SeededScriptModule {
  resolveBackendPlan(
    design: { model?: string },
    env: Record<string, string | undefined>,
  ): {
    backend: "cloud" | "local" | "unknown";
    stateStore: string;
    reason: string;
    missing: string[];
  };
  resolveMemoryDir(
    agentId: string,
    env: Record<string, string | undefined>,
    homeDir?: string,
  ): string;
  validateDesign(raw: unknown): {
    design: { name: string } | null;
    errors: string[];
  };
  hasValidFrontmatter(content: string): boolean;
  classifyMemoryFileWrite(
    existingContent: string | null,
    designContent: string,
  ): "create" | "stage-existing" | "skip";
  applyMemoryFilesToCheckout(
    memoryDir: string,
    agentId: string,
    files: Array<{ path: string; content: string }>,
  ): {
    created: string[];
    staged: string[];
    skipped: string[];
    committed: boolean;
  };
  buildSdkCreateAgentOptions(design: {
    name: string;
    persona: string;
    human?: string;
    model?: string;
    systemBlocks?: Array<{
      label: string;
      value: string;
      description?: string;
    }>;
  }): Record<string, unknown>;
}

async function importSeededScript(): Promise<SeededScriptModule> {
  const content = getTutorSkillFile(`${SKILL_PREFIX}scripts/create-agent.ts`);
  const dir = mkdtempSync(join(tmpdir(), "designing-an-agent-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "create-agent.ts");
  writeFileSync(scriptPath, content, "utf-8");
  // Imported (not executed): import.meta.main is false, so main() must not run.
  return await import(scriptPath);
}

describe("designing-an-agent tutor skill", () => {
  test("tutor seeds the complete skill via default memory files; other personalities do not", () => {
    const tutorFiles = getPersonalityDefaultMemoryFiles("tutorial");
    const skillPaths = tutorFiles
      .map((file) => file.path)
      .filter((path) => path.startsWith(SKILL_PREFIX));
    expect(skillPaths.sort()).toEqual([
      `${SKILL_PREFIX}SKILL.md`,
      `${SKILL_PREFIX}references/affordances.md`,
      `${SKILL_PREFIX}references/context-constitution.md`,
      `${SKILL_PREFIX}references/memory-design.md`,
      `${SKILL_PREFIX}scripts/create-agent.ts`,
    ]);

    // Every seeded entry resolves to a bundled asset that exists on disk.
    for (const file of tutorFiles) {
      expect(existsSync(getPersonalityAssetPath(file.assetId))).toBe(true);
    }

    for (const option of PERSONALITY_OPTIONS) {
      if (option.id === "tutorial") continue;
      expect(getPersonalityDefaultMemoryFiles(option.id)).toEqual([]);
    }
  });

  test("profile picture seeding is preserved alongside the skill", () => {
    const tutorFiles = getPersonalityDefaultMemoryFiles("tutorial");
    expect(tutorFiles[0]).toEqual({
      path: "profile.png",
      assetId: "tutor-profile",
      commitMessage: "chore: set default Tutor profile picture",
    });
    expect(tutorFiles.length).toBe(6);
  });

  test("designing-an-agent is not a globally bundled skill and ships in the npm package", async () => {
    const bundled = await getBundledSkills();
    expect(bundled.map((skill) => skill.id)).not.toContain(
      "designing-an-agent",
    );

    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
    ) as { files: string[] };
    expect(packageJson.files).toContain("assets/designing-an-agent");
    expect(packageJson.files).not.toContain("assets");
  });

  test("SKILL.md has valid frontmatter and grounds the workflow", () => {
    const skill = getTutorSkillFile(`${SKILL_PREFIX}SKILL.md`);
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: designing-an-agent");
    expect(skill).toContain("description:");
    // Real workflow anchors: confirmation, plan-first, skills inventory, SDK create.
    expect(skill).toContain("acquiring-skills");
    expect(skill).toContain("letta skills list");
    expect(skill).toContain("plan --design");
    expect(skill).toContain("create --design");
    expect(skill).toContain("--yes");
    expect(skill).toContain("references/context-constitution.md");
    expect(skill).toContain("references/memory-design.md");
    // Skills from the closed tutor-skills branch are not referenced.
    expect(skill).not.toContain("building-a-claw");
    expect(skill).not.toContain("deploying-agents");
    expect(skill).not.toContain("creating-channels");
  });

  test("constitution references carry attribution and the real principles", () => {
    const constitution = getTutorSkillFile(
      `${SKILL_PREFIX}references/context-constitution.md`,
    );
    expect(constitution).toContain(
      "https://github.com/letta-ai/context-constitution",
    );
    expect(constitution).toContain("CC0 1.0 Universal");
    expect(constitution).toContain(
      "The context window is a precious resource that must be actively managed.",
    );
    expect(constitution).toContain("Progressive Disclosure");
    expect(constitution).toContain("System Prompt Learning");

    const affordances = getTutorSkillFile(
      `${SKILL_PREFIX}references/affordances.md`,
    );
    expect(affordances).toContain("CC0 1.0 Universal");
    expect(affordances).toContain("Memory Filesystem (MemFS)");
  });

  test("create-agent script transpiles as TypeScript", () => {
    const content = getTutorSkillFile(`${SKILL_PREFIX}scripts/create-agent.ts`);
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    expect(() => transpiler.transformSync(content)).not.toThrow();
    // Must not run on import and must not force a server.
    expect(content).toContain("import.meta.main");
    expect(content).toContain("@letta-ai/letta-agent-sdk");
  });

  test("script backend selection keys off the runtime agent identity", async () => {
    const script = await importSeededScript();

    // Cloud Tutor behind a Desktop localhost proxy: the agent id decides,
    // not the base URL.
    const cloudBehindProxy = script.resolveBackendPlan(
      { model: "anthropic/claude-sonnet-4-5" },
      {
        LETTA_AGENT_ID: "agent-1234abcd",
        LETTA_BASE_URL: "http://localhost:8284",
        LETTA_API_KEY: "sk-test",
      },
    );
    expect(cloudBehindProxy.backend).toBe("cloud");
    expect(cloudBehindProxy.missing).toEqual([]);

    const cloudUnready = script.resolveBackendPlan(
      {},
      { AGENT_ID: "agent-1234abcd" },
    );
    expect(cloudUnready.backend).toBe("cloud");
    expect(cloudUnready.missing.length).toBe(2);

    // Local-backend agent id wins even when a Cloud-looking URL is present.
    const localAgent = script.resolveBackendPlan(
      {},
      {
        LETTA_AGENT_ID: "agent-local-1234abcd",
        LETTA_BASE_URL: "https://api.letta.com",
        LETTA_API_KEY: "sk-test",
      },
    );
    expect(localAgent.backend).toBe("local");
    expect(localAgent.stateStore).toBe("local-backend");
    expect(localAgent.missing).toEqual([]);

    // No identity: the experimental flag is the only fallback.
    const flagFallback = script.resolveBackendPlan(
      {},
      { LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1" },
    );
    expect(flagFallback.backend).toBe("local");

    // No identity and no flag: ambiguous — must not guess from the URL.
    const ambiguous = script.resolveBackendPlan(
      {},
      { LETTA_BASE_URL: "http://localhost:8283" },
    );
    expect(ambiguous.backend).toBe("unknown");
    expect(ambiguous.missing.length).toBe(1);
    expect(ambiguous.missing[0]).toContain("Cannot determine");
  });

  test("script memory dir resolution keys off the created agent id", async () => {
    const script = await importSeededScript();
    expect(script.resolveMemoryDir("agent-1", {}, "/home/u")).toBe(
      "/home/u/.letta/agents/agent-1/memory",
    );
    expect(script.resolveMemoryDir("agent-local-1", {}, "/home/u")).toBe(
      "/home/u/.letta/lc-local-backend/memfs/agent-local-1/memory",
    );
    expect(
      script.resolveMemoryDir(
        "agent-local-1",
        { LETTA_LOCAL_BACKEND_DIR: "/srv/letta" },
        "/home/u",
      ),
    ).toBe("/srv/letta/memfs/agent-local-1/memory");
  });

  test("script SDK create options avoid preset strings and duplicate blocks", async () => {
    const script = await importSeededScript();

    const withBlocks = script.buildSdkCreateAgentOptions({
      name: "Research Assistant",
      persona: "I track papers.",
      human: "Sam reads ML papers.",
      model: "anthropic/claude-sonnet-4-5",
      systemBlocks: [
        {
          label: "purpose",
          value: "I exist to track papers.",
          description: "Why",
        },
      ],
    });
    // The app-server adapter rejects preset name strings and appends blocks
    // for top-level persona/human itself — so with custom blocks, persona
    // and human must appear exactly once, as block objects in `memory`.
    expect(withBlocks.persona).toBeUndefined();
    expect(withBlocks.human).toBeUndefined();
    const memory = withBlocks.memory as Array<
      string | { label: string; value: string }
    >;
    expect(memory.some((item) => typeof item === "string")).toBe(false);
    const labels = memory.map((item) =>
      typeof item === "string" ? item : item.label,
    );
    expect(labels).toEqual(["persona", "human", "purpose"]);
    expect(labels.filter((label) => label === "persona").length).toBe(1);
    expect(withBlocks.memfs).toBe(true);

    // Without custom blocks, only the top-level convenience fields are used.
    const withoutBlocks = script.buildSdkCreateAgentOptions({
      name: "Planner",
      persona: "I plan.",
    });
    expect(withoutBlocks.memory).toBeUndefined();
    expect(withoutBlocks.persona).toBe("I plan.");
  });

  test("script design validation protects existing memory and system tier", async () => {
    const script = await importSeededScript();

    const valid = script.validateDesign({
      name: "Research Assistant",
      persona: "I am a research assistant.",
      systemBlocks: [{ label: "purpose", value: "I exist to track papers." }],
      memoryFiles: [
        {
          path: "reference/reading-list.md",
          content: "---\ndescription: Papers to read\n---\n\n# List",
        },
      ],
      skills: ["https://github.com/owner/repo/tree/main/path/to/skill"],
    });
    expect(valid.errors).toEqual([]);
    expect(valid.design?.name).toBe("Research Assistant");

    const invalid = script.validateDesign({
      name: "",
      persona: "",
      systemBlocks: [{ label: "persona", value: "override" }],
      memoryFiles: [
        { path: "system/purpose.md", content: "nope" },
        { path: "../escape.md", content: "nope" },
        { path: "reference/a.md", content: "a" },
        { path: "reference/a.md", content: "a" },
      ],
    });
    expect(invalid.design).toBeNull();
    expect(invalid.errors.join("\n")).toContain("`name` is required.");
    expect(invalid.errors.join("\n")).toContain("reserved");
    expect(invalid.errors.join("\n")).toContain("under system/");
    expect(invalid.errors.join("\n")).toContain("safe relative path");
    expect(invalid.errors.join("\n")).toContain("listed twice");
  });

  test("script validation rejects Markdown memory files without frontmatter", async () => {
    const script = await importSeededScript();

    expect(
      script.hasValidFrontmatter("---\ndescription: ok\n---\n\n# Body"),
    ).toBe(true);
    expect(script.hasValidFrontmatter("---\ndescription: ok\n---")).toBe(true);
    expect(script.hasValidFrontmatter("# Body only")).toBe(false);
    expect(script.hasValidFrontmatter("--- not frontmatter")).toBe(false);

    // Rejected at plan/validation time — before any agent is created — with
    // an actionable error, so the MemFS pre-commit hook can never fire on it.
    const missingFrontmatter = script.validateDesign({
      name: "Agent",
      persona: "I am.",
      memoryFiles: [
        { path: "reference/smoke.md", content: "# No frontmatter" },
      ],
    });
    expect(missingFrontmatter.design).toBeNull();
    expect(missingFrontmatter.errors.join("\n")).toContain(
      "Markdown without frontmatter",
    );

    // Non-Markdown files are exempt.
    const nonMarkdown = script.validateDesign({
      name: "Agent",
      persona: "I am.",
      memoryFiles: [{ path: "reference/data.json", content: "{}" }],
    });
    expect(nonMarkdown.errors).toEqual([]);
  });

  test("script scaffold commit is resumable and never overwrites (real git)", async () => {
    const script = await importSeededScript();

    expect(script.classifyMemoryFileWrite(null, "a")).toBe("create");
    expect(script.classifyMemoryFileWrite("a", "a")).toBe("stage-existing");
    expect(script.classifyMemoryFileWrite("b", "a")).toBe("skip");

    const repo = mkdtempSync(join(tmpdir(), "designing-an-agent-repo-"));
    tempDirs.push(repo);
    Bun.spawnSync({ cmd: ["git", "init", "-q", repo] });
    const notesFile = {
      path: "reference/notes.md",
      content: "---\ndescription: Notes\n---\n\n# Notes\n",
    };
    const files = [notesFile];

    // Fresh checkout: file is created and committed.
    const first = script.applyMemoryFilesToCheckout(
      repo,
      "agent-local-x",
      files,
    );
    expect(first.created).toEqual(["reference/notes.md"]);
    expect(first.committed).toBe(true);
    const log = Bun.spawnSync({ cmd: ["git", "-C", repo, "log", "--oneline"] });
    expect(log.stdout.toString()).toContain("scaffold initial memory");

    // Re-run on committed state: nothing new to commit, nothing skipped.
    const second = script.applyMemoryFilesToCheckout(
      repo,
      "agent-local-x",
      files,
    );
    expect(second.created).toEqual([]);
    expect(second.staged).toEqual(["reference/notes.md"]);
    expect(second.committed).toBe(false);

    // Untracked file matching the design (previous run wrote it but the
    // commit failed): re-staged and committed, not classified as skipped.
    const orphan = {
      path: "reference/orphan.md",
      content: "---\ndescription: Orphan\n---\n\n# Orphan\n",
    };
    writeFileSync(join(repo, "reference/orphan.md"), orphan.content, "utf-8");
    const resumed = script.applyMemoryFilesToCheckout(repo, "agent-local-x", [
      orphan,
    ]);
    expect(resumed.staged).toEqual(["reference/orphan.md"]);
    expect(resumed.skipped).toEqual([]);
    expect(resumed.committed).toBe(true);

    // Existing file with different content: skipped and left untouched.
    const conflicting = {
      path: "reference/notes.md",
      content: "---\ndescription: Different\n---\n\n# Different\n",
    };
    const third = script.applyMemoryFilesToCheckout(repo, "agent-local-x", [
      conflicting,
    ]);
    expect(third.skipped).toEqual(["reference/notes.md"]);
    expect(third.committed).toBe(false);
    expect(readFileSync(join(repo, "reference/notes.md"), "utf-8")).toBe(
      notesFile.content,
    );
  });

  test("script plan mode runs end-to-end without side effects", async () => {
    const content = getTutorSkillFile(`${SKILL_PREFIX}scripts/create-agent.ts`);
    const dir = mkdtempSync(join(tmpdir(), "designing-an-agent-plan-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "create-agent.ts");
    writeFileSync(scriptPath, content, "utf-8");
    const designPath = join(dir, "design.json");
    writeFileSync(
      designPath,
      JSON.stringify({
        name: "Planner",
        persona: "I plan.",
        memoryFiles: [
          {
            path: "reference/notes.md",
            content: "---\ndescription: Notes\n---\n\n# Notes",
          },
        ],
      }),
      "utf-8",
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, "plan", "--design", designPath],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LETTA_AGENT_ID: "agent-local-tutor1",
      },
    });
    const output = JSON.parse(result.stdout.toString());
    expect(output.mode).toBe("plan");
    expect(output.valid).toBe(true);
    expect(output.backend).toBe("local");
    expect(output.agent.memoryFiles).toEqual(["reference/notes.md"]);
    expect(result.exitCode).toBe(0);

    // Without any identity/backend signal, the plan must fail as ambiguous.
    const ambiguous = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, "plan", "--design", designPath],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LETTA_BASE_URL: "http://localhost:8283",
      },
    });
    const ambiguousOutput = JSON.parse(ambiguous.stdout.toString());
    expect(ambiguousOutput.valid).toBe(false);
    expect(ambiguousOutput.backend).toBe("unknown");
    expect(ambiguous.exitCode).toBe(2);

    // create without --yes must refuse before touching anything.
    const refused = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, "create", "--design", designPath],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LETTA_AGENT_ID: "agent-local-tutor1",
      },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("Refusing to create");
  });
});
