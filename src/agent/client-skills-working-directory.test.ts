import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
} from "@/agent/client-skills";

const tempRoots: string[] = [];

afterEach(async () => {
  invalidateClientSkillsPayloadCache();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createSkill(skillsRoot: string, id: string): Promise<string> {
  const skillDirectory = join(skillsRoot, id);
  const skillPath = join(skillDirectory, "SKILL.md");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    [
      "---",
      `name: ${id}`,
      `description: Skill from ${id}`,
      "---",
      "",
      `# ${id}`,
    ].join("\n"),
  );
  return skillPath;
}

function createProjectSkill(
  projectDirectory: string,
  id: string,
): Promise<string> {
  return createSkill(join(projectDirectory, ".agents", "skills"), id);
}

test("discovers project skills from the requested working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "letta-client-skill-cwd-"));
  tempRoots.push(root);
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  await createProjectSkill(firstProject, "first-skill");
  const secondSkillPath = await createProjectSkill(
    secondProject,
    "second-skill",
  );
  const legacySkillPath = await createSkill(
    join(secondProject, ".skills"),
    "legacy-skill",
  );
  const environmentSkillsDirectory = join(root, "environment-skills");
  const environmentSkillPath = await createSkill(
    environmentSkillsDirectory,
    "environment-skill",
  );

  const result = await buildClientSkillsPayload({
    workingDirectory: secondProject,
    skillsDirectory: environmentSkillsDirectory,
    skillSources: ["project"],
  });

  expect(result.clientSkills).toEqual([
    {
      name: "environment-skill",
      description: "Skill from environment-skill",
      location: environmentSkillPath,
    },
    {
      name: "legacy-skill",
      description: "Skill from legacy-skill",
      location: legacySkillPath,
    },
    {
      name: "second-skill",
      description: "Skill from second-skill",
      location: secondSkillPath,
    },
  ]);
});

test("uses the working directory in the skill cache key", async () => {
  const root = await mkdtemp(join(tmpdir(), "letta-client-skill-cache-cwd-"));
  tempRoots.push(root);
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  await createProjectSkill(firstProject, "first-skill");
  await createProjectSkill(secondProject, "second-skill");

  const sharedOptions = {
    skillsDirectory: join(root, "environment-skills"),
    skillSources: ["project" as const],
  };
  const first = await buildClientSkillsPayload({
    ...sharedOptions,
    workingDirectory: firstProject,
  });
  const second = await buildClientSkillsPayload({
    ...sharedOptions,
    workingDirectory: secondProject,
  });

  expect(first.clientSkills.map((skill) => skill.name)).toEqual([
    "first-skill",
  ]);
  expect(second.clientSkills.map((skill) => skill.name)).toEqual([
    "second-skill",
  ]);
});

test("explicit invalidation refreshes changed skill metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "letta-client-skill-refresh-"));
  tempRoots.push(root);
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory, { recursive: true });
  const skillPath = await createProjectSkill(projectDirectory, "mutable-skill");
  const options = {
    workingDirectory: projectDirectory,
    skillsDirectory: join(projectDirectory, ".skills"),
    skillSources: ["project" as const],
  };
  const initial = await buildClientSkillsPayload(options);
  await writeFile(
    skillPath,
    [
      "---",
      "name: mutable-skill",
      "description: Updated description",
      "---",
      "",
      "# mutable-skill",
    ].join("\n"),
  );

  const cached = await buildClientSkillsPayload(options);
  expect(cached.clientSkills).toEqual(initial.clientSkills);
  invalidateClientSkillsPayloadCache();
  const refreshed = await buildClientSkillsPayload(options);
  expect(refreshed.clientSkills[0]?.description).toBe("Updated description");
});
