import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scriptPath = join(
  import.meta.dir,
  "builtin/upgrading-memory-filesystem/scripts/memfs-v2.mjs",
);
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memfs-v2-migration-"));
  temporaryRoots.push(root);
  return root;
}

function git(memoryDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: "utf8",
  });
}

async function write(root: string, relativePath: string, content: string) {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

function runScript(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function createLegacyMemory(root: string): Promise<string> {
  const memoryDir = join(root, "memory");
  await mkdir(memoryDir);
  await write(
    memoryDir,
    "system/persona/soul.md",
    "---\ndescription: How I behave.\nlimit: 1000\n---\nBe curious.\n",
  );
  await write(
    memoryDir,
    "notes.md",
    "---\nname: Existing Notes\ndescription: Useful root notes.\nread_only: false\n---\nRemember [Soul](system/persona/soul.md), `[[system/persona/soul.md|Soul notes]]`, and [the reference][soul].\n\n[soul]: system/persona/soul.md\n",
  );
  await write(memoryDir, "projects/details.md", "Project detail.\n");
  await write(
    memoryDir,
    "skills/sample/SKILL.md",
    "---\nname: sample\ndescription: Sample skill.\n---\nRun it.\n",
  );
  await write(memoryDir, "profile.png", "not-a-real-png");
  git(memoryDir, ["init", "-q", "-b", "main"]);
  git(memoryDir, ["config", "user.name", "Test Agent"]);
  git(memoryDir, ["config", "user.email", "test@example.com"]);
  git(memoryDir, [
    "add",
    "notes.md",
    "profile.png",
    "projects",
    "skills",
    "system",
  ]);
  git(memoryDir, ["commit", "-m", "legacy memory"]);
  return memoryDir;
}

async function reviewPreparedTree(output: string): Promise<void> {
  await writeFile(
    join(output, "MEMORY.md"),
    "# Memory\n\n- [Persona](persona-soul.md)\n- [Projects](projects/MEMORY.md)\n",
    "utf8",
  );
  await writeFile(
    join(output, "projects/MEMORY.md"),
    "# Projects\n\n- [Details](details.md)\n",
    "utf8",
  );
  const detailsPath = join(output, "projects/details.md");
  const details = await readFile(detailsPath, "utf8");
  await writeFile(
    detailsPath,
    details.replace(
      'description: "TODO: Describe when this memory should be loaded."',
      'description: "Project details used when working on active projects."',
    ),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MemFS v2 migration script", () => {
  test("stages a reviewable root-first tree without changing the source", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");

    const report = JSON.parse(
      runScript(["stage", "--source", memoryDir, "--output", output]),
    ) as {
      flattened: Array<{ from: string; to: string }>;
      generated_indexes: string[];
      derived_names: string[];
      todo_descriptions: string[];
    };

    expect(report.flattened).toContainEqual({
      from: "system/persona/soul.md",
      to: "persona-soul.md",
    });
    expect(report.generated_indexes).toEqual([
      "MEMORY.md",
      "projects/MEMORY.md",
    ]);
    expect(report.derived_names).toEqual([
      "persona-soul.md",
      "projects/details.md",
    ]);
    expect(report.todo_descriptions).toEqual(["projects/details.md"]);

    const persona = await readFile(join(output, "persona-soul.md"), "utf8");
    expect(persona).toContain('name: "Persona Soul"');
    expect(persona).toContain('description: "How I behave."');
    expect(persona).not.toContain("limit:");
    expect((persona.match(/^name:/gm) ?? []).length).toBe(1);
    expect((persona.match(/^description:/gm) ?? []).length).toBe(1);

    const notes = await readFile(join(output, "notes.md"), "utf8");
    expect(notes).toContain("[Soul](persona-soul.md)");
    expect(notes).toContain("[Soul notes](persona-soul.md)");
    expect(notes).not.toContain("`[Soul notes]");
    expect(notes).toContain("[soul]: persona-soul.md");

    const rootIndex = await readFile(join(output, "MEMORY.md"), "utf8");
    expect(rootIndex).toStartWith("# Memory\n");
    expect(rootIndex).not.toStartWith("---");
    expect(
      await readFile(join(output, "projects/MEMORY.md"), "utf8"),
    ).toContain("TODO: Replace this generated index");
    expect(await readFile(join(output, "skills/sample/SKILL.md"), "utf8")).toBe(
      "---\nname: sample\ndescription: Sample skill.\n---\nRun it.\n",
    );
    expect(await readFile(join(output, "profile.png"), "utf8")).toBe(
      "not-a-real-png",
    );

    expect(
      await readFile(join(memoryDir, "system/persona/soul.md"), "utf8"),
    ).toContain("limit: 1000");
    expect(git(memoryDir, ["status", "--porcelain"])).toBe("");
    expect(() => runScript(["validate", "--source", output])).toThrow(
      "generated index placeholder",
    );
    await reviewPreparedTree(output);
    expect(() => runScript(["validate", "--source", output])).not.toThrow();
  });

  test("refuses flattening collisions", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(
      memoryDir,
      "persona-soul.md",
      "---\ndescription: Collision.\n---\nCollision.\n",
    );
    git(memoryDir, ["add", "persona-soul.md"]);
    git(memoryDir, ["commit", "-m", "add collision"]);

    expect(() =>
      runScript([
        "stage",
        "--source",
        memoryDir,
        "--output",
        join(root, "review"),
      ]),
    ).toThrow("Destination collision");
  });

  test("refuses case-only collisions on portable filesystems", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(
      memoryDir,
      "Persona-Soul.md",
      "---\ndescription: Root collision.\n---\nCollision.\n",
    );
    git(memoryDir, ["add", "Persona-Soul.md"]);
    git(memoryDir, ["commit", "-m", "add case collision"]);

    expect(() =>
      runScript([
        "stage",
        "--source",
        memoryDir,
        "--output",
        join(root, "review"),
      ]),
    ).toThrow("Destination collision");
  });

  test("stages committed HEAD without copying ignored files", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(memoryDir, ".gitignore", "ignored.md\n");
    git(memoryDir, ["add", ".gitignore"]);
    git(memoryDir, ["commit", "-m", "ignore local file"]);
    await write(memoryDir, "ignored.md", "Ignored local content.\n");
    const output = join(root, "review");

    runScript(["stage", "--source", memoryDir, "--output", output]);

    expect(await readFile(join(memoryDir, "ignored.md"), "utf8")).toBe(
      "Ignored local content.\n",
    );
    await expect(access(join(output, "ignored.md"))).rejects.toThrow();
  });

  test("keeps flattened committed files even when the destination is ignored", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(memoryDir, ".gitignore", "/ignored.md\n");
    await write(
      memoryDir,
      "system/ignored.md",
      "---\ndescription: Tracked memory.\n---\nKeep this.\n",
    );
    git(memoryDir, ["add", ".gitignore", "system/ignored.md"]);
    git(memoryDir, ["commit", "-m", "add ignored destination"]);
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    const activateCommand = join(root, "activate.mjs");
    await writeFile(
      activateCommand,
      "process.stdout.write(JSON.stringify({ system_prompt_updated: true }));\n",
      "utf8",
    );

    runScript(
      [
        "apply",
        "--source",
        output,
        "--memory-dir",
        memoryDir,
        "--agent",
        "agent-local-test",
      ],
      {
        AGENT_ID: "agent-local-test",
        LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
        LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([activateCommand]),
      },
    );

    expect(await readFile(join(memoryDir, "ignored.md"), "utf8")).toContain(
      "Keep this.",
    );
    expect(git(memoryDir, ["ls-files", "ignored.md"]).trim()).toBe(
      "ignored.md",
    );
  });

  test("preserves multiline descriptions and frontmatter closed at EOF", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(
      memoryDir,
      "system/multiline.md",
      "---\ndescription: First line\n  continued on the next line\n---\nBody.\n",
    );
    await write(
      memoryDir,
      "system/empty.md",
      "---\ndescription: Empty body.\n---",
    );
    git(memoryDir, ["add", "system/multiline.md", "system/empty.md"]);
    git(memoryDir, ["commit", "-m", "add frontmatter variants"]);
    const output = join(root, "review");

    runScript(["stage", "--source", memoryDir, "--output", output]);

    expect(await readFile(join(output, "multiline.md"), "utf8")).toContain(
      'description: "First line continued on the next line"',
    );
    expect(await readFile(join(output, "empty.md"), "utf8")).toEndWith("---\n");
  });

  test("applies and commits only a validated prepared tree", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    const previousHead = git(memoryDir, ["rev-parse", "HEAD"]).trim();
    const activateCommand = join(root, "activate.mjs");
    const activateLog = join(root, "activate.log");
    await writeFile(
      activateCommand,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.ACTIVATE_LOG, process.argv.slice(2).join(" "));',
        "process.stdout.write(JSON.stringify({ system_prompt_updated: true }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = JSON.parse(
      runScript(
        [
          "apply",
          "--source",
          output,
          "--memory-dir",
          memoryDir,
          "--agent",
          "agent-local-test",
        ],
        {
          AGENT_ID: "agent-local-test",
          AGENT_NAME: "Test Agent",
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([activateCommand]),
          ACTIVATE_LOG: activateLog,
        },
      ),
    ) as {
      commit: string;
      changed_paths: string[];
      activation: { system_prompt_updated: boolean };
    };

    expect(result.commit).not.toBe(previousHead);
    expect(result.changed_paths).toContain("MEMORY.md");
    expect(result.changed_paths).toContain("system/persona/soul.md");
    expect(result.activation.system_prompt_updated).toBe(true);
    const activationArgs = await readFile(activateLog, "utf8");
    const canonicalMemoryDir = await realpath(memoryDir);
    expect(activationArgs).toContain(
      "--backend local agents memfs-v2 --agent agent-local-test",
    );
    expect(activationArgs).toContain(`--memory-dir ${canonicalMemoryDir}`);
    expect(activationArgs).toContain(`--memory-commit ${result.commit}`);
    expect(
      await readFile(join(memoryDir, "persona-soul.md"), "utf8"),
    ).toContain('name: "Persona Soul"');
    expect(
      await readFile(join(memoryDir, "skills/sample/SKILL.md"), "utf8"),
    ).toBe("---\nname: sample\ndescription: Sample skill.\n---\nRun it.\n");
    expect(git(memoryDir, ["status", "--porcelain"])).toBe("");
  });

  test("reverts the conversion commit when activation fails before tagging", async () => {
    const root = await temporaryRoot();
    const agentId = "agent-local-test";
    const agentRoot = join(root, "storage", "memfs", agentId);
    await mkdir(agentRoot, { recursive: true });
    const memoryDir = await createLegacyMemory(agentRoot);
    const agentsDir = join(root, "storage", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, `${Buffer.from(agentId).toString("base64url")}.json`),
      JSON.stringify({ id: agentId, tags: [] }),
      "utf8",
    );
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    const failingCommand = join(root, "fail-activation.mjs");
    await writeFile(failingCommand, "process.exit(1);\n", "utf8");

    expect(() =>
      runScript(
        [
          "apply",
          "--source",
          output,
          "--memory-dir",
          memoryDir,
          "--agent",
          agentId,
        ],
        {
          AGENT_ID: agentId,
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([failingCommand]),
        },
      ),
    ).toThrow("conversion commit was reverted");
    expect(
      await readFile(join(memoryDir, "system/persona/soul.md"), "utf8"),
    ).toContain("How I behave");
    await expect(access(join(memoryDir, "persona-soul.md"))).rejects.toThrow();
    expect(git(memoryDir, ["status", "--porcelain"])).toBe("");
    expect(git(memoryDir, ["log", "-1", "--pretty=%s"])).toContain("Revert");
  });

  test("refuses a dirty source tree", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    await write(memoryDir, "dirty.md", "Uncommitted.\n");

    expect(() =>
      runScript([
        "stage",
        "--source",
        memoryDir,
        "--output",
        join(root, "review"),
      ]),
    ).toThrow("Memory repository has uncommitted changes");
  });

  test("refuses prepared skill changes", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    await writeFile(join(output, "skills/sample/SKILL.md"), "Changed.\n");

    expect(() =>
      runScript(
        [
          "apply",
          "--source",
          output,
          "--memory-dir",
          memoryDir,
          "--agent",
          "agent-local-test",
        ],
        { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      ),
    ).toThrow("Prepared skills differ");
    expect(
      await readFile(join(memoryDir, "skills/sample/SKILL.md"), "utf8"),
    ).toBe("---\nname: sample\ndescription: Sample skill.\n---\nRun it.\n");
  });

  test("refuses reserved Git state in the prepared tree", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    await mkdir(join(output, ".git"));

    expect(() =>
      runScript(
        [
          "apply",
          "--source",
          output,
          "--memory-dir",
          memoryDir,
          "--agent",
          "agent-local-test",
        ],
        { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      ),
    ).toThrow("must not contain .git");
  });

  test("refuses to replace memory committed after staging", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    runScript(["stage", "--source", memoryDir, "--output", output]);
    await reviewPreparedTree(output);
    await write(memoryDir, "newer.md", "Newer committed memory.\n");
    git(memoryDir, ["add", "newer.md"]);
    git(memoryDir, ["commit", "-m", "newer memory"]);

    expect(() =>
      runScript(
        [
          "apply",
          "--source",
          output,
          "--memory-dir",
          memoryDir,
          "--agent",
          "agent-local-test",
        ],
        { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      ),
    ).toThrow("changed after the review tree was staged");
    expect(await readFile(join(memoryDir, "newer.md"), "utf8")).toBe(
      "Newer committed memory.\n",
    );
  });
});
