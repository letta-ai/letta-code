import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { loadRenderedSkillContent, skill } from "./skill";
import { consumeQueuedSkillContent } from "./skill-content-registry";

let root: string;
let skillsDir: string;
const previousOptIn = process.env.LETTA_SKILL_COMMAND_EXPANSION;
const previousConfig = process.env.LETTA_CONFIG_DIR;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "letta-skill-expansion-")));
  skillsDir = join(root, ".agents", "skills");
  mkdirSync(join(skillsDir, "probe"), { recursive: true });
  process.env.LETTA_CONFIG_DIR = join(root, "user-config");
  delete process.env.LETTA_SKILL_COMMAND_EXPANSION;
  consumeQueuedSkillContent();
});

afterEach(() => {
  if (previousOptIn === undefined)
    delete process.env.LETTA_SKILL_COMMAND_EXPANSION;
  else process.env.LETTA_SKILL_COMMAND_EXPANSION = previousOptIn;
  if (previousConfig === undefined) delete process.env.LETTA_CONFIG_DIR;
  else process.env.LETTA_CONFIG_DIR = previousConfig;
  consumeQueuedSkillContent();
  rmSync(root, { recursive: true, force: true });
});

function fixture(body: string, frontmatter = "") {
  writeFileSync(join(skillsDir, "probe", "SKILL.md"), frontmatter + body);
}

function scoped<T>(fn: () => T) {
  return runWithRuntimeContext(
    {
      workingDirectory: root,
      skillsDirectory: skillsDir,
      permissionMode: "unrestricted",
    },
    fn,
  );
}

function load() {
  return scoped(() => loadRenderedSkillContent("probe", { skillsDir }));
}

test("inline commands stay literal by default, even with allowed-tools", async () => {
  const marker = join(root, "marker");
  const body = `!\`touch ${marker}\``;
  fixture(body, "---\nallowed-tools: Bash\n---\n");
  expect(await load()).toContain(body);
  expect(existsSync(marker)).toBe(false);
});

test("opt-in expands commands in the runtime workspace and preserves literal dollar output", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("Directory: !`pwd`\nValue: !`printf '%s' '$&'`");
  const content = await load();
  expect(content).toContain(`Directory: ${root}`);
  expect(content).toContain("Value: $&");
  expect(content).not.toContain("!`");
});

test("Skill queues expanded content through the same loader", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("Context: !`printf fresh-context`");
  await scoped(() => skill({ skill: "probe", toolCallId: "expansion-call" }));
  expect(consumeQueuedSkillContent()).toEqual([
    {
      toolCallId: "expansion-call",
      content: expect.stringContaining("Context: fresh-context"),
    },
  ]);
});

test("frontmatter cannot execute commands", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  const marker = join(root, "metadata-marker");
  fixture(
    "Body: !`printf body-context`",
    `---\ndescription: !\`touch ${marker}\`\n---\n`,
  );
  const content = await load();
  expect(content).toContain("Body: body-context");
  expect(content).toContain(`description: !\`touch ${marker}\``);
  expect(existsSync(marker)).toBe(false);
});

test("disabled model invocation is rejected before any command executes", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  const marker = join(root, "disabled-marker");
  fixture(`!\`touch ${marker}\``, "---\ndisable-model-invocation: true\n---\n");
  await expect(load()).rejects.toThrow("disable-model-invocation");
  expect(existsSync(marker)).toBe(false);
});

test("explicit Bash denial still blocks opted-in commands", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  mkdirSync(join(root, ".letta"));
  writeFileSync(
    join(root, ".letta", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash"] } }),
  );
  const marker = join(root, "denied-marker");
  fixture(`!\`touch ${marker}\``);
  await expect(load()).rejects.toThrow("permission");
  expect(existsSync(marker)).toBe(false);
});

test("failed commands stop skill loading instead of injecting partial context", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("!`exit 7`");
  await expect(load()).rejects.toThrow("7");
  expect(consumeQueuedSkillContent()).toHaveLength(0);
});

test("commands requiring approval do not execute silently", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  const marker = join(root, "approval-marker");
  fixture(`!\`touch ${marker}\``);
  await expect(
    runWithRuntimeContext(
      {
        workingDirectory: root,
        skillsDirectory: skillsDir,
        permissionMode: "standard",
      },
      () => loadRenderedSkillContent("probe", { skillsDir }),
    ),
  ).rejects.toThrow("permission");
  expect(existsSync(marker)).toBe(false);
});

test("all commands are checked before the first one runs", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  mkdirSync(join(root, ".letta"));
  writeFileSync(
    join(root, ".letta", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(exit:*)"] } }),
  );
  const marker = join(root, "preflight-marker");
  fixture(`!\`touch ${marker}\` !\`exit 7\``);
  await expect(load()).rejects.toThrow("permission");
  expect(existsSync(marker)).toBe(false);
});

test("inline command execution times out", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("!`sleep 20`");
  await expect(load()).rejects.toThrow();
}, 15_000);

test("command output is not interpreted as a skill-directory placeholder", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("Value: !`printf '\\074SKILL_DIR\\076'`");
  expect(await load()).toContain("Value: <SKILL_DIR>");
});

test("resource filenames cannot execute commands", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("Context: !`printf fresh-context`");
  writeFileSync(
    join(skillsDir, "probe", "!`touch resource-marker`"),
    "resource",
  );
  expect(await load()).toContain("!`touch resource-marker`");
  expect(existsSync(join(root, "resource-marker"))).toBe(false);
});

test("runtime tool restrictions still apply when expansion is enabled", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  const marker = join(root, "restricted-marker");
  fixture(`!\`touch ${marker}\``);
  await expect(
    runWithRuntimeContext(
      {
        workingDirectory: root,
        skillsDirectory: skillsDir,
        permissionMode: "unrestricted",
        executionSettings: {
          allowed_tools: [],
          disallowed_tools: ["Bash"],
          disable_memory_guard: false,
        },
      },
      () => loadRenderedSkillContent("probe", { skillsDir }),
    ),
  ).rejects.toThrow("permission");
  expect(existsSync(marker)).toBe(false);
});

test("concurrent skill loads keep separate runtime workspaces", async () => {
  process.env.LETTA_SKILL_COMMAND_EXPANSION = "1";
  fixture("Workspace: !`pwd`");
  const directories = [join(root, "left"), join(root, "right")];
  for (const directory of directories) mkdirSync(directory);
  const results = await Promise.all(
    directories.map((workingDirectory) =>
      runWithRuntimeContext(
        {
          workingDirectory,
          skillsDirectory: skillsDir,
          permissionMode: "unrestricted",
        },
        () => loadRenderedSkillContent("probe", { skillsDir }),
      ),
    ),
  );
  expect(results[0]).toContain(`Workspace: ${directories[0]}`);
  expect(results[1]).toContain(`Workspace: ${directories[1]}`);
});
