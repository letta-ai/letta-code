import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  MEMORY_CONSTRAINTS_UPDATE_ENV,
  MEMORY_CONSTRAINTS_VALIDATOR_NAME,
} from "./memory-constraints";
import {
  installPreCommitHook,
  installSharedMemoryPreCommitHook,
} from "./memory-git-hooks";

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  return repo;
}

function tryCommit(
  repo: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync("git", ["commit", "-m", message], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
}

function v2Memory(body: string, name = "Notes"): string {
  return `---\nname: ${name}\ndescription: Test memory\n---\n${body}`;
}

function seedConstraints(repo: string, config: Record<string, unknown>): void {
  writeFileSync(
    join(repo, MEMORY_CONSTRAINTS_CONFIG_PATH),
    `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`,
  );
  execFileSync("git", ["add", MEMORY_CONSTRAINTS_CONFIG_PATH], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "seed constraints"], { cwd: repo });
}

describe("MemFS v2 pre-commit hook", () => {
  let repo = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("requires indexes for Markdown directories while ignoring skills", () => {
    repo = initRepo("memfs-v2-hook-");
    installPreCommitHook(repo, true);

    mkdirSync(join(repo, "silent"));
    mkdirSync(join(repo, "skills", "demo"), { recursive: true });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(repo, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent.\n',
    );
    writeFileSync(join(repo, "silent", "notes.md"), "Not projected.\n");
    writeFileSync(join(repo, "skills", "demo", "SKILL.md"), "Skill format.\n");
    execFileSync(
      "git",
      ["add", "MEMORY.md", "persona.md", "silent", "skills"],
      {
        cwd: repo,
      },
    );
    const missingIndex = tryCommit(repo, "reject unindexed memory");
    expect(missingIndex.status).not.toBe(0);
    expect(missingIndex.stdout + missingIndex.stderr).toContain(
      "silent/notes.md: missing required index silent/MEMORY.md",
    );

    writeFileSync(
      join(repo, "silent", "MEMORY.md"),
      "# Silent is now memory\n",
    );
    execFileSync("git", ["add", "silent/MEMORY.md"], { cwd: repo });
    const activatedDirectory = spawnSync(
      "git",
      ["commit", "-m", "activate silent directory"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(activatedDirectory.status).not.toBe(0);
    expect(activatedDirectory.stdout + activatedDirectory.stderr).toContain(
      "silent/notes.md: missing frontmatter",
    );

    writeFileSync(join(repo, "silent", "notes.md"), v2Memory("Indexed.\n"));
    execFileSync("git", ["add", "silent/notes.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed valid v2 memory"], {
      cwd: repo,
    });
    writeFileSync(
      join(repo, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\nextra: "no"\n---\nPersistent.\n',
    );
    execFileSync("git", ["add", "persona.md"], { cwd: repo });
    const extraKey = spawnSync("git", ["commit", "-m", "invalid frontmatter"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(extraKey.status).not.toBe(0);
    expect(extraKey.stdout + extraKey.stderr).toContain(
      "unknown frontmatter key 'extra' (allowed: name description)",
    );
  });

  test("applies canonical v2 defaults when the tracked config is absent", () => {
    repo = initRepo("memfs-v2-default-constraints-");
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "persona.md"), v2Memory("p".repeat(20_000)));
    execFileSync("git", ["add", "MEMORY.md", "persona.md"], { cwd: repo });

    const result = tryCommit(repo, "reject default file overflow");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "exceeds 20000 from maxFileCharacters",
    );
  });

  test("fills fields missing from an older v2 config with canonical defaults", () => {
    repo = initRepo("memfs-v2-upgraded-defaults-");
    seedConstraints(repo, {
      maxDepth: 2,
      maxFileCharacters: 20_000,
    });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        join(repo, `core-${index}.md`),
        v2Memory("c".repeat(16_000), `Core ${index}`),
      );
    }
    execFileSync("git", ["add", "."], { cwd: repo });

    const result = tryCommit(repo, "reject upgraded core overflow");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "core memory exceeds maxCoreMemoryCharacters 65536",
    );
  });

  test("limits the combined root memory while excluding deferred child files", () => {
    repo = initRepo("memfs-v2-core-limit-");
    seedConstraints(repo, {
      maxDepth: 2,
      maxFileCharacters: 1_000,
      maxCoreMemoryCharacters: 220,
    });
    installPreCommitHook(repo, true);

    mkdirSync(join(repo, "reference"));
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "reference", "MEMORY.md"), "# Reference\n");
    writeFileSync(
      join(repo, "reference", "large.md"),
      v2Memory("d".repeat(700)),
    );
    writeFileSync(join(repo, "persona.md"), v2Memory("p".repeat(70)));
    writeFileSync(join(repo, "soul.md"), v2Memory("s".repeat(70)));
    execFileSync("git", ["add", "."], { cwd: repo });

    const result = tryCommit(repo, "reject oversized core memory");
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain("core memory exceeds maxCoreMemoryCharacters 220");
    expect(output).not.toContain("reference/large.md: core memory");
  });

  test("applies the default file limit unless the first glob override matches", () => {
    repo = initRepo("memfs-v2-constraints-");
    seedConstraints(repo, {
      maxFileCharacters: 80,
      fileCharacterLimits: [
        { pattern: "reference/**/*.md", maxCharacters: 220 },
        { pattern: "reference/private/**", maxCharacters: 60 },
      ],
    });
    installPreCommitHook(repo, true);

    mkdirSync(join(repo, "reference", "private"), { recursive: true });
    mkdirSync(join(repo, "skills", "demo"), { recursive: true });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "reference", "MEMORY.md"), "# Reference\n");
    writeFileSync(
      join(repo, "reference", "private", "MEMORY.md"),
      "# Private\n",
    );
    writeFileSync(
      join(repo, "reference", "private", "notes.md"),
      v2Memory("r".repeat(100)),
    );
    writeFileSync(join(repo, "persona.md"), v2Memory("p".repeat(100)));
    writeFileSync(join(repo, "skills", "demo", "SKILL.md"), "s".repeat(500));
    execFileSync("git", ["add", "."], { cwd: repo });

    const result = tryCommit(repo, "check file limits");
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain("persona.md:");
    expect(output).toContain("exceeds 80 from maxFileCharacters");
    expect(output).not.toContain("reference/private/notes.md:");
    expect(output).not.toContain("skills/demo/SKILL.md:");
  });

  test("allows a glob override to remove the default file limit", () => {
    repo = initRepo("memfs-v2-unlimited-override-");
    seedConstraints(repo, {
      maxFileCharacters: 60,
      fileCharacterLimits: [{ pattern: "MEMORY.md", maxCharacters: null }],
    });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "m".repeat(500));
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    expect(tryCommit(repo, "allow large index").status).toBe(0);
  });

  test("enforces directory depth on the projected staged tree", () => {
    repo = initRepo("memfs-v2-depth-");
    seedConstraints(repo, { maxDepth: 1 });
    installPreCommitHook(repo, true);

    mkdirSync(join(repo, "reference", "deep"), { recursive: true });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "reference", "MEMORY.md"), "# Reference\n");
    writeFileSync(join(repo, "reference", "deep", "MEMORY.md"), "# Deep\n");
    writeFileSync(
      join(repo, "reference", "deep", "notes.md"),
      v2Memory("Nested.\n"),
    );
    execFileSync("git", ["add", "."], { cwd: repo });

    const result = tryCommit(repo, "check depth");
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "reference/deep/MEMORY.md: depth 2 exceeds maxDepth 1",
    );
    expect(output).toContain(
      "reference/deep/notes.md: depth 2 exceeds maxDepth 1",
    );
  });

  test("counts characters in the staged snapshot instead of bytes or working content", () => {
    repo = initRepo("memfs-v2-staged-size-");
    const content = v2Memory("🧠");
    seedConstraints(repo, {
      maxFileCharacters: Array.from(content).length,
    });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "persona.md"), content);
    execFileSync("git", ["add", "MEMORY.md", "persona.md"], { cwd: repo });
    writeFileSync(join(repo, "persona.md"), `${content}unstaged`);

    expect(tryCommit(repo, "use staged size").status).toBe(0);
  });

  test("keeps v2 constraints active when the root marker is staged for deletion", () => {
    repo = initRepo("memfs-v2-delete-marker-");
    seedConstraints(repo, { maxFileCharacters: 80 });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "persona.md"), v2Memory("Short.\n"));
    execFileSync("git", ["add", "MEMORY.md", "persona.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed v2 memory"], { cwd: repo });
    installPreCommitHook(repo, true);

    execFileSync("git", ["rm", "MEMORY.md"], { cwd: repo });
    writeFileSync(join(repo, "persona.md"), v2Memory("p".repeat(100)));
    execFileSync("git", ["add", "persona.md"], { cwd: repo });

    const result = tryCommit(repo, "delete marker and grow memory");
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain(
      "MEMORY.md: root memory index is required for MemFS v2",
    );
    expect(output).toContain(
      "persona.md: 145 characters exceeds 80 from maxFileCharacters",
    );
  });

  test("rejects symlinked memory Markdown instead of counting its target path", () => {
    repo = initRepo("memfs-v2-symlink-");
    seedConstraints(repo, { maxFileCharacters: 80 });
    installPreCommitHook(repo, true);

    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      encoding: "utf8",
      input: "huge.txt",
    }).trim();
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `120000,${blob},MEMORY.md`],
      { cwd: repo },
    );

    const result = tryCommit(repo, "add symlinked index");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "MEMORY.md: memory Markdown must be a regular file",
    );
  });

  test("streams staged files larger than the default child-process buffer", () => {
    repo = initRepo("memfs-v2-large-file-");
    seedConstraints(repo, {
      maxFileCharacters: 2_000_000,
      maxCoreMemoryCharacters: 2_000_000,
    });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "m".repeat(1_100_000));
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    expect(tryCommit(repo, "allow configured large file").status).toBe(0);
  });

  test("rejects globstars that are not complete path segments", () => {
    repo = initRepo("memfs-v2-invalid-glob-");
    seedConstraints(repo, {
      fileCharacterLimits: [{ pattern: "reference/**.md", maxCharacters: 100 }],
    });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    const result = tryCommit(repo, "reject ambiguous globstar");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "'**' must be a complete path segment",
    );
  });

  test("rejects unsupported config versions", () => {
    repo = initRepo("memfs-v2-config-version-");
    seedConstraints(repo, { version: 2, maxDepth: 1 });
    installPreCommitHook(repo, true);

    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    const result = tryCommit(repo, "reject unsupported config");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      ".memfs.config.json: version must be 1",
    );
  });

  test("protects and validates the tracked constraint config", () => {
    repo = initRepo("memfs-v2-protected-constraints-");
    seedConstraints(repo, { maxDepth: 2 });
    installPreCommitHook(repo, true);

    expect(
      existsSync(
        join(repo, ".git", "hooks", MEMORY_CONSTRAINTS_VALIDATOR_NAME),
      ),
    ).toBe(true);
    writeFileSync(
      join(repo, MEMORY_CONSTRAINTS_CONFIG_PATH),
      '{"maxDepth":"deep"}\n',
    );
    execFileSync("git", ["add", MEMORY_CONSTRAINTS_CONFIG_PATH], { cwd: repo });

    const protectedResult = tryCommit(repo, "change constraints");
    expect(protectedResult.status).not.toBe(0);
    expect(protectedResult.stdout + protectedResult.stderr).toContain(
      "requires human approval to change",
    );

    const invalidResult = tryCommit(repo, "approve invalid constraints", {
      ...process.env,
      [MEMORY_CONSTRAINTS_UPDATE_ENV]: "1",
    });
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stdout + invalidResult.stderr).toContain(
      "maxDepth must be a non-negative integer",
    );

    writeFileSync(
      join(repo, MEMORY_CONSTRAINTS_CONFIG_PATH),
      '{"version":1,"maxDepth":3}\n',
    );
    execFileSync("git", ["add", MEMORY_CONSTRAINTS_CONFIG_PATH], { cwd: repo });
    expect(
      tryCommit(repo, "approve valid constraints", {
        ...process.env,
        [MEMORY_CONSTRAINTS_UPDATE_ENV]: "1",
      }).status,
    ).toBe(0);

    execFileSync("git", ["rm", MEMORY_CONSTRAINTS_CONFIG_PATH], { cwd: repo });
    const deleteResult = tryCommit(repo, "delete constraints");
    expect(deleteResult.status).not.toBe(0);
    expect(deleteResult.stdout + deleteResult.stderr).toContain(
      "requires human approval to change",
    );
  });
});

describe("legacy MemFS pre-commit hook", () => {
  let repo = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("enforces the default file limit under system", () => {
    repo = initRepo("legacy-memory-constraints-");
    seedConstraints(repo, { maxFileCharacters: 70 });
    installPreCommitHook(repo);

    mkdirSync(join(repo, "system"));
    writeFileSync(
      join(repo, "system", "notes.md"),
      "---\ndescription: Test memory\n---\n" + "n".repeat(100),
    );
    execFileSync("git", ["add", "system/notes.md"], { cwd: repo });

    const result = tryCommit(repo, "check legacy size");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "exceeds 70 from maxFileCharacters",
    );
  });
});

describe("shared-memory pre-commit hook", () => {
  let repo = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("requires name and description without a root marker", () => {
    repo = initRepo("shared-memory-hook-");

    installSharedMemoryPreCommitHook(repo);

    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(
      readFileSync(join(repo, ".git", "letta-memory-layout-policy"), "utf8"),
    ).toBe("shared-memory\n");

    writeFileSync(
      join(repo, "missing-name.md"),
      "---\ndescription: Purpose\n---\nBody.\n",
    );
    writeFileSync(
      join(repo, "missing-description.md"),
      "---\nname: Notes\n---\nBody.\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo });

    const result = spawnSync("git", ["commit", "-m", "invalid memory"], {
      cwd: repo,
      encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain("missing-name.md: missing required field 'name'");
    expect(output).toContain(
      "missing-description.md: missing required field 'description'",
    );
  });

  test("enforces file limits without requiring a root marker", () => {
    repo = initRepo("shared-memory-constraints-");
    seedConstraints(repo, { maxFileCharacters: 70 });
    installSharedMemoryPreCommitHook(repo);

    writeFileSync(join(repo, "notes.md"), v2Memory("n".repeat(100)));
    execFileSync("git", ["add", "notes.md"], { cwd: repo });

    const result = tryCommit(repo, "check shared size");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("notes.md:");
    expect(result.stdout + result.stderr).toContain(
      "exceeds 70 from maxFileCharacters",
    );
  });
});
