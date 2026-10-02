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
import { commitMemoryWrite, initializeLocalMemoryRepo } from "./memory-git";
import {
  buildPreCommitHookScript,
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

  test.each(["modify", "delete", "rename", "mode", "create"])(
    "protects config-selected files against %s, including non-Markdown",
    (operation) => {
      repo = initRepo("memfs-readonly-");
      seedConstraints(repo, { readOnlyFiles: ["locked.*"] });
      writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
      writeFileSync(join(repo, "locked.txt"), "accepted\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "seed memory"], { cwd: repo });
      installPreCommitHook(repo, true);
      if (operation === "modify")
        writeFileSync(join(repo, "locked.txt"), "changed\n");
      if (operation === "delete")
        execFileSync("git", ["rm", "locked.txt"], { cwd: repo });
      if (operation === "rename")
        execFileSync("git", ["mv", "locked.txt", "other.txt"], { cwd: repo });
      if (operation === "mode")
        execFileSync("git", ["update-index", "--chmod=+x", "locked.txt"], {
          cwd: repo,
        });
      if (operation === "create")
        writeFileSync(join(repo, "locked.new"), "new\n");
      if (operation !== "mode")
        execFileSync("git", ["add", "-A"], { cwd: repo });
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      });
      const result = tryCommit(repo, "reject protected change");
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("read-only");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ).toBe(head);
    },
  );

  test("checks staged formatting without rewriting files and preserves Markdown semantics", () => {
    repo = initRepo("memfs-format-");
    seedConstraints(repo, {
      formatting: {
        lineEndings: "lf",
        finalNewline: true,
        trailingWhitespace: true,
      },
    });
    installPreCommitHook(repo, true);
    const invalid = "# Memory\r\ntext \r\nmissing newline";
    // Exercise the installed validator under the distribution's Node runtime.
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      buildPreCommitHookScript({ execPath: "node", electron: false }),
    );
    writeFileSync(join(repo, "MEMORY.md"), invalid);
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    const valid =
      "# Memory\n\nline  \nhard break\n\n````text\n```\ncode   \n````\n\n    indented code   \n\n> ~~~\n> quoted code   \n> ~~~\n";
    writeFileSync(join(repo, "MEMORY.md"), valid);
    const rejected = tryCommit(repo, "reject staged formatting");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain("formatting");
    expect(rejected.stdout + rejected.stderr).toContain("LF line endings");
    expect(rejected.stdout + rejected.stderr).toContain("final newline");
    expect(rejected.stdout + rejected.stderr).toContain("trailing whitespace");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(valid);
    expect(
      execFileSync("git", ["show", ":MEMORY.md"], {
        cwd: repo,
        encoding: "utf8",
      }),
    ).toBe(invalid);
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    expect(tryCommit(repo, "accept formatting").status).toBe(0);
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
    const output = result.stdout + result.stderr;
    expect(output).toContain("exceeds 20000 from maxFileCharacters");
    expect(output).toContain("Memory validation blocked this commit.");
    expect(output).toContain(
      "No files were committed. Your staged changes are still present.",
    );
    expect(output).toContain(
      "Validation checks the complete repository, so these problems may predate your staged changes.",
    );
    expect(output).toContain(
      "Move non-core detail out of root Markdown and behind MEMORY.md indexes.",
    );
    expect(output).toContain(
      "Do not raise or disable these limits unless the user explicitly approves it.",
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
    expect(result.stdout + result.stderr).toContain("core memory:");
    expect(result.stdout + result.stderr).toContain(
      "characters exceeds 65536 from maxCoreMemoryCharacters",
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
    expect(output).toContain(
      "characters exceeds 220 from maxCoreMemoryCharacters",
    );
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

describe("local memory commit hook policy", () => {
  let repo = "";
  const author = {
    agentId: "agent-local-hook-policy",
    authorName: "Local Hook Test",
    authorEmail: "local-hook-test@letta.com",
  };

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("keeps root-marker validation after a local memory write", async () => {
    repo = mkdtempSync(join(tmpdir(), "local-root-hook-policy-"));
    await initializeLocalMemoryRepo({
      memoryDir: repo,
      agentId: author.agentId,
      authorName: author.authorName,
      files: [
        { relativePath: "MEMORY.md", content: "# Memory\n" },
        {
          relativePath: "persona.md",
          content: v2Memory("Initial.\n", "Persona"),
        },
      ],
    });

    writeFileSync(join(repo, "persona.md"), v2Memory("Updated.\n", "Persona"));
    const committed = await commitMemoryWrite({
      memoryDir: repo,
      pathspecs: ["persona.md"],
      reason: "test: update root memory",
      author,
      syncMode: "local",
    });

    expect(committed.committed).toBe(true);
    expect(
      readFileSync(join(repo, ".git", "letta-memory-layout-policy"), "utf8"),
    ).toBe("root-marker\n");

    writeFileSync(join(repo, "notes.md"), "Missing frontmatter.\n");
    await expect(
      commitMemoryWrite({
        memoryDir: repo,
        pathspecs: ["notes.md"],
        reason: "test: reject invalid root memory",
        author,
        syncMode: "local",
      }),
    ).rejects.toThrow("Memory validation failed");

    rmSync(join(repo, "MEMORY.md"));
    await expect(
      commitMemoryWrite({
        memoryDir: repo,
        pathspecs: ["MEMORY.md"],
        reason: "test: reject root marker deletion",
        author,
        syncMode: "local",
      }),
    ).rejects.toThrow("root memory index is required for MemFS v2");
    expect(
      readFileSync(join(repo, ".git", "letta-memory-layout-policy"), "utf8"),
    ).toBe("root-marker\n");
  });

  test("keeps markerless local repositories on legacy validation", async () => {
    repo = mkdtempSync(join(tmpdir(), "local-legacy-hook-policy-"));
    await initializeLocalMemoryRepo({
      memoryDir: repo,
      agentId: author.agentId,
      authorName: author.authorName,
      files: [
        {
          relativePath: "system/persona.md",
          content: "---\ndescription: Persona\n---\nInitial.\n",
        },
      ],
    });

    writeFileSync(
      join(repo, "system", "persona.md"),
      "---\ndescription: Persona\n---\nUpdated.\n",
    );
    const committed = await commitMemoryWrite({
      memoryDir: repo,
      pathspecs: ["system/persona.md"],
      reason: "test: update legacy memory",
      author,
      syncMode: "local",
    });

    expect(committed.committed).toBe(true);
    expect(
      readFileSync(join(repo, ".git", "letta-memory-layout-policy"), "utf8"),
    ).toBe("legacy-only\n");
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
      `---\ndescription: Test memory\n---\n${"n".repeat(100)}`,
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

  test("rejects an unrelated commit when tracked memory is already invalid", () => {
    repo = initRepo("shared-memory-existing-invalid-");
    writeFileSync(join(repo, "invalid.md"), "missing frontmatter\n");
    execFileSync("git", ["add", "invalid.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed invalid memory"], {
      cwd: repo,
    });
    installSharedMemoryPreCommitHook(repo);

    writeFileSync(join(repo, "unrelated.txt"), "not memory\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: repo });
    const result = tryCommit(repo, "reject existing invalid memory");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "invalid.md: missing frontmatter",
    );
  });

  test("validates a large tracked tree without passing every path to the runtime", () => {
    repo = initRepo("shared-memory-many-paths-");
    for (let index = 0; index < 240; index += 1) {
      writeFileSync(
        join(
          repo,
          `notes-${String(index).padStart(4, "0")}-${"x".repeat(145)}.md`,
        ),
        v2Memory("valid\n"),
      );
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    // Seed the tracked tree before installing the hook. The tested commit only
    // stages a non-Markdown file, but v2 validation must still scan the tree.
    execFileSync("git", ["commit", "-qm", "seed many memory files"], {
      cwd: repo,
    });
    installSharedMemoryPreCommitHook(repo);

    const shim = join(repo, "git-bash-runtime");
    writeFileSync(
      shim,
      `#!/bin/sh
length=0
for arg do length=$((length + \${#arg} + 1)); done
if [ "$length" -gt 32767 ]; then
  echo "simulated Windows command line limit" >&2
  exit 90
fi
exec node "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      buildPreCommitHookScript({ execPath: shim, electron: false }),
      { mode: 0o755 },
    );

    writeFileSync(join(repo, "unrelated.txt"), "not memory\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: repo });
    const valid = tryCommit(repo, "commit despite many memory paths");
    expect(valid.stdout + valid.stderr).not.toContain(
      "simulated Windows command line limit",
    );
    expect(valid.status).toBe(0);

    const firstMemoryPath = `notes-0000-${"x".repeat(145)}.md`;
    writeFileSync(join(repo, firstMemoryPath), "invalid\n");
    execFileSync("git", ["add", firstMemoryPath], { cwd: repo });
    const invalid = tryCommit(repo, "reject bad memory in large tree");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toContain("missing frontmatter");
  }, 30_000);
});
