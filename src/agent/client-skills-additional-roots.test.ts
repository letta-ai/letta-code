import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
} from "@/agent/client-skills";
import {
  SANDBOX_WORKSPACE_ROOT,
  sandboxRepositoryLayout,
} from "@/cloud-sandbox-workspace";
import { runWithRuntimeContext } from "@/runtime-context";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import { readSkillContent } from "@/tools/impl/skill";

const tempRoots: string[] = [];

afterEach(async () => {
  invalidateClientSkillsPayloadCache();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createProjectSkill(
  repository: string,
  id: string,
  description = `Skill from ${id}`,
): Promise<string> {
  const directory = join(repository, ".agents", "skills", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(
    path,
    ["---", `name: ${id}`, `description: ${description}`, "---", ""].join("\n"),
  );
  return path;
}

/** Two cloned repos laid out the way a sandbox launch lays them out. */
async function twoRepositories() {
  const root = await mkdtemp(join(tmpdir(), "letta-extra-skill-roots-"));
  tempRoots.push(root);
  const app = join(root, "app");
  const lib = join(root, "lib");
  const appSkill = await createProjectSkill(app, "app-skill");
  const libSkill = await createProjectSkill(lib, "lib-skill");
  const appShared = await createProjectSkill(app, "shared", "From app");
  await createProjectSkill(lib, "shared", "From lib");
  const layout = sandboxRepositoryLayout([
    { owner: "owner", repo: "app" },
    { owner: "owner", repo: "lib" },
  ]);
  // Sandbox paths are always Linux paths, whatever the parent runs on.
  expect(layout.skillDirectories).toEqual([
    "/root/workspace/lib/.agents/skills",
  ]);
  // The same layout as local paths under the temp directory, which stands in
  // for the sandbox workspace root.
  const skillDirectories = layout.skillDirectories.map((dir) =>
    join(root, ...posix.relative(SANDBOX_WORKSPACE_ROOT, dir).split("/")),
  );
  return { app, appSkill, libSkill, appShared, skillDirectories };
}

test("a second repository's .agents/skills joins the first repository's", async () => {
  const repos = await twoRepositories();
  expect(repos.skillDirectories).toEqual([
    join(repos.app, "..", "lib", ".agents", "skills"),
  ]);

  const result = await buildClientSkillsPayload({
    workingDirectory: repos.app,
    additionalSkillsDirectories: repos.skillDirectories,
    skillSources: ["project"],
  });

  expect(result.clientSkills).toEqual([
    {
      name: "app-skill",
      description: "Skill from app-skill",
      location: repos.appSkill,
    },
    {
      name: "lib-skill",
      description: "Skill from lib-skill",
      location: repos.libSkill,
    },
    // The working directory's own skill wins a name clash.
    { name: "shared", description: "From app", location: repos.appShared },
  ]);
});

test("extra roots follow the project source and default to the launch settings", async () => {
  const repos = await twoRepositories();
  const withoutProject = await buildClientSkillsPayload({
    workingDirectory: repos.app,
    additionalSkillsDirectories: repos.skillDirectories,
    skillSources: ["global"],
  });
  expect(withoutProject.clientSkills.map((skill) => skill.name)).not.toContain(
    "lib-skill",
  );

  const executionSettings: RuntimeExecutionSettings = {
    allowed_tools: [],
    disallowed_tools: [],
    disable_memory_guard: false,
    skill_directories: repos.skillDirectories,
  };
  const fromSettings = await runWithRuntimeContext(
    { workingDirectory: repos.app, executionSettings },
    () =>
      buildClientSkillsPayload({
        workingDirectory: repos.app,
        skillSources: ["project"],
      }),
  );
  expect(fromSettings.clientSkills.map((skill) => skill.name)).toContain(
    "lib-skill",
  );

  // The Skill tool reads from the same extra roots during the turn.
  const loaded = await runWithRuntimeContext(
    { workingDirectory: repos.app, executionSettings },
    () => readSkillContent("lib-skill", join(repos.app, ".skills")),
  );
  expect(loaded.path).toBe(repos.libSkill);
});
