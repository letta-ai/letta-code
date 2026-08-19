import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const scriptPath = join(
  import.meta.dir,
  "builtin/migrating-memory/scripts/memfs-v2.mjs",
);
const targetActivationPath = join(
  import.meta.dir,
  "builtin/migrating-memory/scripts/target-activation.mjs",
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

function stageScript(source: string, target: string, output: string): string {
  return runScript([
    "stage",
    "--source",
    source,
    "--target",
    target,
    "--output",
    output,
  ]);
}

function validateScript(prepared: string): string {
  return runScript(["validate", "--prepared", prepared]);
}

function applyScript(options: {
  prepared: string;
  target: string;
  targetAgent?: string;
  targetBackend?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return runScript(
    [
      "apply",
      "--prepared",
      options.prepared,
      "--target",
      options.target,
      "--target-agent",
      options.targetAgent ?? "agent-local-test",
      "--target-backend",
      options.targetBackend ?? "local",
    ],
    options.env,
  );
}

async function createLegacyMemory(root: string): Promise<string> {
  const memoryDir = join(root, "memory");
  await mkdir(memoryDir, { recursive: true });
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

async function createTargetMemory(root: string): Promise<string> {
  const memoryDir = join(root, "memory");
  await mkdir(memoryDir, { recursive: true });
  await write(
    memoryDir,
    "system/target.md",
    "---\ndescription: Initial target memory.\n---\nReplace me.\n",
  );
  await write(memoryDir, "target-only.txt", "Target marker.\n");
  git(memoryDir, ["init", "-q", "-b", "main"]);
  git(memoryDir, ["config", "user.name", "Target Agent"]);
  git(memoryDir, ["config", "user.email", "target@example.com"]);
  git(memoryDir, ["add", "system", "target-only.txt"]);
  git(memoryDir, ["commit", "-m", "initial target memory"]);
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

    const report = JSON.parse(stageScript(memoryDir, memoryDir, output)) as {
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
    expect(() => validateScript(output)).toThrow("generated index placeholder");
    await reviewPreparedTree(output);
    expect(() => validateScript(output)).not.toThrow();
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
      stageScript(memoryDir, memoryDir, join(root, "review")),
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
      stageScript(memoryDir, memoryDir, join(root, "review")),
    ).toThrow("Destination collision");
  });

  test("stages committed HEAD without copying ignored source files", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    await write(source, ".gitignore", "ignored.md\n");
    git(source, ["add", ".gitignore"]);
    git(source, ["commit", "-m", "ignore local file"]);
    await write(source, "ignored.md", "Ignored local content.\n");
    const output = join(root, "review");

    stageScript(source, target, output);

    expect(await readFile(join(source, "ignored.md"), "utf8")).toBe(
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
    stageScript(memoryDir, memoryDir, output);
    await reviewPreparedTree(output);
    const activateCommand = join(root, "activate.mjs");
    await writeFile(
      activateCommand,
      "process.stdout.write(JSON.stringify({ system_prompt_updated: true }));\n",
      "utf8",
    );

    applyScript({
      prepared: output,
      target: memoryDir,
      env: {
        AGENT_ID: "agent-local-test",
        LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
        LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([activateCommand]),
      },
    });

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

    stageScript(memoryDir, memoryDir, output);

    expect(await readFile(join(output, "multiline.md"), "utf8")).toContain(
      'description: "First line continued on the next line"',
    );
    expect(await readFile(join(output, "empty.md"), "utf8")).toEndWith("---\n");
  });

  test("applies and commits only a validated prepared tree", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    stageScript(memoryDir, memoryDir, output);
    await reviewPreparedTree(output);
    const previousHead = git(memoryDir, ["rev-parse", "HEAD"]).trim();
    const activateCommand = join(root, "activate.mjs");
    const activateLog = join(root, "activate.log");
    await writeFile(
      activateCommand,
      [
        "#!/usr/bin/env node",
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.ACTIVATE_LOG, process.argv.slice(2).join(" ") + "\\n");',
        "process.stdout.write(JSON.stringify({ system_prompt_updated: true }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = JSON.parse(
      applyScript({
        prepared: output,
        target: memoryDir,
        env: {
          AGENT_ID: "agent-local-test",
          AGENT_NAME: "Test Agent",
          LETTA_CODE_BIN: process.execPath,
          LETTA_CODE_BIN_ARGS_JSON: JSON.stringify([activateCommand]),
          ACTIVATE_LOG: activateLog,
        },
      }),
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
    expect(activationArgs).toContain(
      `--memory-dir ${canonicalMemoryDir} --preflight`,
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

  test("resolves activation through the sibling packaged CLI", async () => {
    const root = await temporaryRoot();
    const packageRoot = join(root, "package");
    const packagedScript = join(
      packageRoot,
      "skills/migrating-memory/scripts/target-activation.mjs",
    );
    const packagedEntrypoint = join(packageRoot, "letta.js");
    await mkdir(dirname(packagedScript), { recursive: true });
    await copyFile(targetActivationPath, packagedScript);
    await writeFile(packagedEntrypoint, "packaged test entrypoint\n", "utf8");
    const probe = join(root, "probe.mjs");
    await writeFile(
      probe,
      [
        `import { resolveActivationInvocation } from ${JSON.stringify(pathToFileURL(packagedScript).href)};`,
        "process.stdout.write(JSON.stringify(resolveActivationInvocation({})));",
        "",
      ].join("\n"),
      "utf8",
    );

    const invocation = JSON.parse(
      execFileSync(process.execPath, [probe], { encoding: "utf8" }),
    ) as { command: string; commandArgs: string[] };
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.commandArgs).toHaveLength(1);
    expect(await readFile(invocation.commandArgs[0] as string, "utf8")).toBe(
      "packaged test entrypoint\n",
    );
  });

  test("moves an exported source into a separate target repository", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const output = join(root, "review");
    const sourceHead = git(source, ["rev-parse", "HEAD"]).trim();
    const targetHead = git(target, ["rev-parse", "HEAD"]).trim();
    const report = JSON.parse(stageScript(source, target, output)) as {
      source: string;
      target: string;
      target_changes: {
        added: string[];
        modified: string[];
        deleted: string[];
      };
    };
    expect(report.source).toBe(await realpath(source));
    expect(report.target).toBe(await realpath(target));
    expect(report.target_changes.added).toContain("persona-soul.md");
    expect(report.target_changes.deleted).toEqual([
      "system/target.md",
      "target-only.txt",
    ]);
    await reviewPreparedTree(output);
    const validation = JSON.parse(validateScript(output)) as {
      target_changes: { deleted: string[] };
    };
    expect(validation.target_changes.deleted).toEqual(
      report.target_changes.deleted,
    );
    const activateCommand = join(root, "activate.mjs");
    const activateLog = join(root, "activate.log");
    await writeFile(
      activateCommand,
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.ACTIVATE_LOG, process.argv.slice(2).join(" ") + "\\n");',
        "process.stdout.write(JSON.stringify({ system_prompt_updated: true }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = JSON.parse(
      applyScript({
        prepared: output,
        target,
        targetAgent: "agent-cloud-test",
        targetBackend: "cloud",
        env: {
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([activateCommand]),
          ACTIVATE_LOG: activateLog,
        },
      }),
    ) as { commit: string; target_dir: string };

    expect(result.commit).not.toBe(targetHead);
    expect(result.target_dir).toBe(await realpath(target));
    expect(await readFile(activateLog, "utf8")).toContain(
      "--backend cloud agents memfs-v2 --agent agent-cloud-test",
    );
    expect(await readFile(activateLog, "utf8")).toContain("--preflight");
    expect(git(source, ["rev-parse", "HEAD"]).trim()).toBe(sourceHead);
    expect(git(source, ["status", "--porcelain"])).toBe("");
    expect(
      await readFile(join(source, "system/persona/soul.md"), "utf8"),
    ).toContain("How I behave");
    expect(await readFile(join(target, "persona-soul.md"), "utf8")).toContain(
      'name: "Persona Soul"',
    );
    await expect(access(join(target, "target-only.txt"))).rejects.toThrow();
    expect(
      await readFile(join(target, "skills/sample/SKILL.md"), "utf8"),
    ).toContain("Sample skill");
    expect(git(target, ["status", "--porcelain"])).toBe("");
  });

  test("rejects an invalid target backend before changing the target", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const targetHead = git(target, ["rev-parse", "HEAD"]).trim();
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);

    expect(() =>
      applyScript({
        prepared: output,
        target,
        targetBackend: "locla",
      }),
    ).toThrow("Unsupported target backend: locla");
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(targetHead);
    expect(await readFile(join(target, "target-only.txt"), "utf8")).toBe(
      "Target marker.\n",
    );
  });

  test("rejects a failed target preflight before changing the target", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const targetHead = git(target, ["rev-parse", "HEAD"]).trim();
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);
    const failingCommand = join(root, "fail-preflight.mjs");
    await writeFile(failingCommand, "process.exit(1);\n", "utf8");

    expect(() =>
      applyScript({
        prepared: output,
        target,
        env: {
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([failingCommand]),
        },
      }),
    ).toThrow("Command failed");
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(targetHead);
    expect(await readFile(join(target, "target-only.txt"), "utf8")).toBe(
      "Target marker.\n",
    );
  });

  test("refuses target changes made while preflight runs", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);
    const preflightCommand = join(root, "change-target-during-preflight.mjs");
    await writeFile(
      preflightCommand,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const args = process.argv.slice(2);",
        'if (args.includes("--preflight")) {',
        '  const target = args[args.indexOf("--memory-dir") + 1];',
        '  writeFileSync(join(target, "late.txt"), "Committed during preflight.\\n");',
        '  execFileSync("git", ["add", "late.txt"], { cwd: target });',
        '  execFileSync("git", ["commit", "-m", "change during preflight"], { cwd: target });',
        "}",
        "process.stdout.write(JSON.stringify({ ready: true }));",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() =>
      applyScript({
        prepared: output,
        target,
        env: {
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([preflightCommand]),
        },
      }),
    ).toThrow("Target repository changed after the review tree was staged");
    expect(await readFile(join(target, "late.txt"), "utf8")).toBe(
      "Committed during preflight.\n",
    );
  });

  test("refuses ignored target files that replacement would delete", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    await write(target, ".gitignore", "ignored-target.txt\n");
    git(target, ["add", ".gitignore"]);
    git(target, ["commit", "-m", "ignore target file"]);
    await write(target, "ignored-target.txt", "Keep me.\n");

    expect(() => stageScript(source, target, join(root, "review"))).toThrow(
      "ignored files that full migration would delete",
    );
    expect(await readFile(join(target, "ignored-target.txt"), "utf8")).toBe(
      "Keep me.\n",
    );
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
    stageScript(memoryDir, memoryDir, output);
    await reviewPreparedTree(output);
    const failingCommand = join(root, "fail-activation.mjs");
    await writeFile(
      failingCommand,
      [
        'if (process.argv.includes("--preflight")) {',
        "  process.stdout.write(JSON.stringify({ ready: true }));",
        "} else {",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() =>
      applyScript({
        prepared: output,
        target: memoryDir,
        targetAgent: agentId,
        env: {
          AGENT_ID: agentId,
          LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath,
          LETTA_MEMFS_V2_ACTIVATE_ARGS: JSON.stringify([failingCommand]),
        },
      }),
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
      stageScript(memoryDir, memoryDir, join(root, "review")),
    ).toThrow("Memory repository has uncommitted changes");
  });

  test("refuses prepared skill changes", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    stageScript(memoryDir, memoryDir, output);
    await reviewPreparedTree(output);
    await writeFile(join(output, "skills/sample/SKILL.md"), "Changed.\n");

    expect(() =>
      applyScript({
        prepared: output,
        target: memoryDir,
        env: { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      }),
    ).toThrow("Prepared skills differ");
    expect(
      await readFile(join(memoryDir, "skills/sample/SKILL.md"), "utf8"),
    ).toBe("---\nname: sample\ndescription: Sample skill.\n---\nRun it.\n");
  });

  test("refuses reserved Git state in the prepared tree", async () => {
    const root = await temporaryRoot();
    const memoryDir = await createLegacyMemory(root);
    const output = join(root, "review");
    stageScript(memoryDir, memoryDir, output);
    await reviewPreparedTree(output);
    await mkdir(join(output, ".git"));

    expect(() =>
      applyScript({
        prepared: output,
        target: memoryDir,
        env: { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      }),
    ).toThrow("must not contain .git");
  });

  test("refuses a target committed after staging", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);
    await write(target, "newer.md", "Newer target memory.\n");
    git(target, ["add", "newer.md"]);
    git(target, ["commit", "-m", "newer target memory"]);

    expect(() =>
      applyScript({
        prepared: output,
        target,
        env: { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      }),
    ).toThrow("Target repository changed after the review tree was staged");
    expect(await readFile(join(target, "newer.md"), "utf8")).toBe(
      "Newer target memory.\n",
    );
  });

  test("refuses a source committed after staging", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);
    await write(source, "newer.md", "Newer source memory.\n");
    git(source, ["add", "newer.md"]);
    git(source, ["commit", "-m", "newer source memory"]);

    expect(() =>
      applyScript({
        prepared: output,
        target,
        env: { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      }),
    ).toThrow("Source repository changed after the review tree was staged");
    expect(await readFile(join(source, "newer.md"), "utf8")).toBe(
      "Newer source memory.\n",
    );
  });

  test("refuses uncommitted source changes after staging", async () => {
    const root = await temporaryRoot();
    const source = await createLegacyMemory(join(root, "source"));
    const target = await createTargetMemory(join(root, "target"));
    const output = join(root, "review");
    stageScript(source, target, output);
    await reviewPreparedTree(output);
    await write(source, "dirty.md", "Uncommitted source memory.\n");

    expect(() =>
      applyScript({
        prepared: output,
        target,
        env: { LETTA_MEMFS_V2_ACTIVATE_COMMAND: process.execPath },
      }),
    ).toThrow("Memory repository has uncommitted changes");
    expect(await readFile(join(target, "target-only.txt"), "utf8")).toBe(
      "Target marker.\n",
    );
  });
});
