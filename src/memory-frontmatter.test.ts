import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PRE_COMMIT_HOOK_SCRIPT } from "@/agent/memory-git-hooks";
import {
  type MemoryFileFrontmatterInput,
  validateMemoryFileFrontmatter,
} from "@/memory-constraints";

const v2 = "---\nname: Notes\ndescription: Notes\n---\nbody\n";
const legacy = "---\ndescription: Notes\n---\nbody\n";
const locked = "---\ndescription: Notes\nread_only: true\n---\nbody\n";
const unlocked = "---\ndescription: Notes\nread_only: false\n---\nbody\n";
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// This table runs against both the public function and a real installed hook.
// It was also run against the pre-extraction Bash hook to preserve its policy.
describe.each(["memfs-v2", "legacy"] as const)("%s frontmatter", (format) => {
  const valid = format === "memfs-v2" ? v2 : legacy;
  const cases: Array<[string, string, string | null, string | null]> = [
    ["valid content", valid, null, null],
    ["missing header", "plain text\n", null, "missing frontmatter"],
    ["unclosed header", "---\ndescription: Notes\n", null, "never closed"],
    ["empty header", "---\n---\nbody\n", null, "missing required field"],
    [
      "empty description",
      valid.replace("description: Notes", "description:"),
      null,
      "must not be empty",
    ],
    [
      "unknown field",
      valid.replace("---\nbody", "extra: true\n---\nbody"),
      null,
      "unknown frontmatter key",
    ],
    [
      "protected field on new file",
      unlocked,
      null,
      format === "memfs-v2" ? "unknown frontmatter key" : "cannot be set",
    ],
  ];
  if (format === "memfs-v2") {
    cases.push(
      ["missing name", legacy, null, "missing required field 'name'"],
      [
        "quoted empty name",
        v2.replace("name: Notes", 'name: ""'),
        null,
        "must not be empty",
      ],
      [
        "quoted empty description",
        v2.replace("description: Notes", "description: ''"),
        null,
        "must not be empty",
      ],
      [
        "duplicate name",
        v2.replace("name: Notes", "name: Notes\nname: Again"),
        null,
        "duplicate frontmatter key",
      ],
      [
        "duplicate description",
        v2.replace(
          "description: Notes",
          "description: Notes\ndescription: Again",
        ),
        null,
        "duplicate frontmatter key",
      ],
      ["indented fields", v2.replace("name:", "  name:"), null, null],
    );
  } else {
    cases.push(
      [
        "legacy limit",
        legacy.replace("---\nbody", "limit: old\n---\nbody"),
        null,
        null,
      ],
      [
        "multiline description",
        legacy.replace("description: Notes", "description: |\n  Notes"),
        null,
        null,
      ],
      [
        "locked edit",
        locked.replace("body", "changed"),
        locked,
        "read_only and cannot be modified",
      ],
      [
        "protected value retained",
        unlocked.replace("body", "changed"),
        unlocked,
        null,
      ],
      ["protected value changed", locked, unlocked, "cannot be changed"],
      ["protected value removed", legacy, unlocked, "cannot be removed"],
      [
        "protected field spelling changed",
        unlocked.replace("read_only:", "read_only :"),
        unlocked,
        "cannot be removed",
      ],
    );
  }
  test.each(cases)("%s", (_label, content, previousContent, expectedError) => {
    const input: MemoryFileFrontmatterInput = {
      path: format === "memfs-v2" ? "notes.md" : "system/notes.md",
      content,
      previousContent,
      format,
    };
    const errors = validateMemoryFileFrontmatter(input);
    if (expectedError) expect(errors.join("\n")).toContain(expectedError);
    else expect(errors).toEqual([]);

    root = mkdtempSync(join(tmpdir(), "memfs-frontmatter-parity-"));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
    git("init", "--quiet");
    const file = join(root, input.path);
    mkdirSync(dirname(file), { recursive: true });
    if (previousContent !== null) {
      writeFileSync(file, previousContent);
      git("add", input.path);
    }
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "accepted base",
    );
    writeFileSync(
      join(root, ".git/letta-memory-layout-policy"),
      format === "memfs-v2" ? "shared-memory\n" : "legacy-only\n",
    );
    writeFileSync(join(root, ".git/hooks/pre-commit"), PRE_COMMIT_HOOK_SCRIPT, {
      mode: 0o755,
    });
    writeFileSync(file, content);
    git("add", input.path);
    const result = spawnSync("git", ["commit", "--quiet", "-m", "candidate"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(result.status === 0).toBe(errors.length === 0);
    for (const error of errors)
      expect(result.stdout + result.stderr).toContain(error);
  });
});

test.each(["MEMORY.md", "reference/MEMORY.md"])(
  "index %s is frontmatter-free",
  (path) => {
    expect(
      validateMemoryFileFrontmatter({
        path,
        content: "# Index\n",
        previousContent: null,
        format: "memfs-v2",
      }),
    ).toEqual([]);
    expect(
      validateMemoryFileFrontmatter({
        path,
        content: v2,
        previousContent: null,
        format: "memfs-v2",
      }),
    ).toEqual([`${path}: MEMORY.md must not have frontmatter`]);
  },
);

test("Node bundle exports the validator and installs a self-contained hook", async () => {
  root = mkdtempSync(join(tmpdir(), "memfs-frontmatter-node-"));
  const result = await Bun.build({
    entrypoints: [
      resolve("src/memory-constraints.ts"),
      resolve("src/agent/memory-git-hooks.ts"),
    ],
    outdir: root,
    target: "node",
    format: "esm",
    naming: "[name].mjs",
  });
  expect(result.success).toBe(true);
  const publicEntry = pathToFileURL(join(root, "memory-constraints.mjs")).href;
  const hookEntry = pathToFileURL(join(root, "memory-git-hooks.mjs")).href;
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  execFileSync("git", ["init", "--quiet"], { cwd: root, env });
  execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { validateMemoryFileFrontmatter } from ${JSON.stringify(publicEntry)};
    import { PRE_COMMIT_HOOK_SCRIPT } from ${JSON.stringify(hookEntry)};
    assert.deepEqual(validateMemoryFileFrontmatter({ path: 'notes.md', content: ${JSON.stringify(v2)}, previousContent: null, format: 'memfs-v2' }), []);
    assert.match(validateMemoryFileFrontmatter({ path: 'system/notes.md', content: ${JSON.stringify(legacy)}, previousContent: ${JSON.stringify(unlocked)}, format: 'legacy' }).join('\\n'), /cannot be removed/);
    writeFileSync('.git/hooks/pre-commit', PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
  `,
    ],
    { cwd: root, env, stdio: "pipe" },
  );
  writeFileSync(
    join(root, ".git/letta-memory-layout-policy"),
    "shared-memory\n",
  );
  writeFileSync(join(root, "notes.md"), v2);
  execFileSync("git", ["add", "notes.md"], { cwd: root, env });
  execFileSync("git", ["commit", "--quiet", "-m", "valid"], {
    cwd: root,
    env,
    stdio: "pipe",
  });
  writeFileSync(join(root, "notes.md"), legacy);
  execFileSync("git", ["add", "notes.md"], { cwd: root, env });
  const rejected = spawnSync("git", ["commit", "--quiet", "-m", "invalid"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  expect(rejected.status).not.toBe(0);
  expect(rejected.stdout + rejected.stderr).toContain(
    "missing required field 'name'",
  );
});

test("one Node process validates a hundred projected files and reports both ends of the batch", () => {
  root = mkdtempSync(join(tmpdir(), "memfs-frontmatter-batch-"));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "--quiet");
  for (let index = 0; index < 100; index++) {
    writeFileSync(join(root, `notes-${String(index).padStart(3, "0")}.md`), v2);
  }
  git("add", "--", "*.md");
  git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "accepted");
  writeFileSync(
    join(root, ".git/letta-memory-layout-policy"),
    "shared-memory\n",
  );
  writeFileSync(join(root, ".git/hooks/pre-commit"), PRE_COMMIT_HOOK_SCRIPT, {
    mode: 0o755,
  });

  // Observe launches, then execute the real Node binary and the real hook.
  const node = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
  }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const launches = join(root, "node-launches");
  writeFileSync(
    join(bin, "node"),
    `#!/usr/bin/env bash\nprintf 'node\\n' >> ${JSON.stringify(launches)}\nexec ${JSON.stringify(node)} "$@"\n`,
    { mode: 0o755 },
  );
  const observedEnv = { ...env, PATH: `${bin}:${env.PATH}` };
  const commit = () =>
    spawnSync(
      "git",
      ["commit", "--allow-empty", "--quiet", "-m", "candidate"],
      { cwd: root, env: observedEnv, encoding: "utf8", timeout: 15_000 },
    );
  const accepted = commit();
  expect(accepted.status).toBe(0);
  expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(1);

  writeFileSync(launches, "");
  writeFileSync(join(root, "notes-000.md"), legacy);
  writeFileSync(join(root, "notes-099.md"), legacy);
  git("add", "--", "*.md");
  const rejected = commit();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stdout + rejected.stderr).toContain(
    "notes-000.md: missing required field 'name'",
  );
  expect(rejected.stdout + rejected.stderr).toContain(
    "notes-099.md: missing required field 'name'",
  );
  expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(1);
}, 30_000);
