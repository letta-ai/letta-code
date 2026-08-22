import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
  invalidateClientSkillsPayloadCacheForAgent,
} from "./client-skills";
import { getRepositoryMountDir } from "./memory-git";

const AGENT_ID = "agent-shared-skills-test";

let tempHome = "";
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let restoreAmbientEnv: (() => void) | undefined;

beforeEach(async () => {
  restoreAmbientEnv = isolateAmbientLettaTestEnv();
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tempHome = await mkdtemp(join(tmpdir(), "letta-shared-skills-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  invalidateClientSkillsPayloadCache();
});

afterEach(async () => {
  invalidateClientSkillsPayloadCache();
  restoreAmbientEnv?.();
  restoreAmbientEnv = undefined;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  await rm(tempHome, { recursive: true, force: true });
});

async function createSkill(
  skillsRoot: string,
  id: string,
  description: string,
): Promise<string> {
  const skillDirectory = join(skillsRoot, id);
  const skillPath = join(skillDirectory, "SKILL.md");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    [
      "---",
      `name: ${id}`,
      `description: ${description}`,
      "---",
      "",
      `# ${id}`,
    ].join("\n"),
  );
  return skillPath;
}

function sharedSkillsRoot(repositoryName: string): string {
  return join(getRepositoryMountDir(AGENT_ID, repositoryName), "skills");
}

function projectDirectory(): string {
  return join(tempHome, "project");
}

function buildOptions(
  attachedRepositories: ReadonlyArray<{ id: string; name: string }>,
) {
  const project = projectDirectory();
  return {
    agentId: AGENT_ID,
    workingDirectory: project,
    skillsDirectory: join(project, ".skills"),
    skillSources: ["project" as const],
    attachedRepositories,
  };
}

test("discovers a skill from an attached shared-memory repository", async () => {
  const skillPath = await createSkill(
    sharedSkillsRoot("shared-team"),
    "shared-review",
    "Review shared changes",
  );

  const result = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-1", name: "shared-team" }]),
  );

  expect(result.clientSkills).toContainEqual({
    name: "shared-review",
    description: "Review shared changes",
    location: skillPath,
  });
  expect(result.availableSkills).toContainEqual({
    id: "shared-review",
    name: "shared-review",
    description: "Review shared changes",
    path: skillPath,
    source: "agent",
  });
});

test("ignores a detached repository whose checkout remains on disk", async () => {
  await createSkill(
    sharedSkillsRoot("detached-repository"),
    "stale-shared-skill",
    "Must not load",
  );

  const result = await buildClientSkillsPayload(buildOptions([]));

  expect(result.clientSkills.map((skill) => skill.name)).not.toContain(
    "stale-shared-skill",
  );
});

test("reports an attached repository whose local mount is missing", async () => {
  const mount = getRepositoryMountDir(AGENT_ID, "missing-repository");

  const result = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-missing", name: "missing-repository" }]),
  );

  expect(result.clientSkills).toEqual([]);
  expect(result.errors).toContainEqual({
    path: mount,
    message: "Attached repository is not mounted locally",
  });
});

test("keeps project and agent-memory skills ahead of shared skills", async () => {
  const projectSkillPath = await createSkill(
    join(projectDirectory(), ".agents", "skills"),
    "project-wins",
    "From project",
  );
  const agentSkillPath = await createSkill(
    join(tempHome, ".letta", "agents", AGENT_ID, "memory", "skills"),
    "agent-wins",
    "From agent memory",
  );
  await createSkill(
    sharedSkillsRoot("shared-team"),
    "project-wins",
    "From shared memory",
  );
  await createSkill(
    sharedSkillsRoot("shared-team"),
    "agent-wins",
    "From shared memory",
  );

  const result = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-1", name: "shared-team" }]),
  );

  expect(result.skillPathById["project-wins"]).toBe(projectSkillPath);
  expect(result.skillPathById["agent-wins"]).toBe(agentSkillPath);
});

test("uses repository-name order for duplicate shared skill ids", async () => {
  const firstPath = await createSkill(
    sharedSkillsRoot("a-repository"),
    "duplicate-shared",
    "From a repository",
  );
  await createSkill(
    sharedSkillsRoot("z-repository"),
    "duplicate-shared",
    "From z repository",
  );

  const result = await buildClientSkillsPayload(
    buildOptions([
      { id: "repo-z", name: "z-repository" },
      { id: "repo-a", name: "a-repository" },
    ]),
  );

  expect(result.skillPathById["duplicate-shared"]).toBe(firstPath);
  expect(
    result.clientSkills.find((skill) => skill.name === "duplicate-shared")
      ?.description,
  ).toBe("From a repository");
});

test("uses attached repository roots in the payload cache key", async () => {
  await createSkill(
    sharedSkillsRoot("first-repository"),
    "first-shared",
    "First attached skill",
  );
  await createSkill(
    sharedSkillsRoot("second-repository"),
    "second-shared",
    "Second attached skill",
  );

  const first = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-1", name: "first-repository" }]),
  );
  const second = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-2", name: "second-repository" }]),
  );

  expect(first.clientSkills.map((skill) => skill.name)).toContain(
    "first-shared",
  );
  expect(first.clientSkills.map((skill) => skill.name)).not.toContain(
    "second-shared",
  );
  expect(second.clientSkills.map((skill) => skill.name)).toContain(
    "second-shared",
  );
  expect(second.clientSkills.map((skill) => skill.name)).not.toContain(
    "first-shared",
  );
});

test("agent cache invalidation refreshes shared skill metadata", async () => {
  const skillPath = await createSkill(
    sharedSkillsRoot("shared-team"),
    "mutable-shared",
    "Original description",
  );
  const options = buildOptions([{ id: "repo-1", name: "shared-team" }]);
  const initial = await buildClientSkillsPayload(options);

  await writeFile(
    skillPath,
    [
      "---",
      "name: mutable-shared",
      "description: Updated description",
      "---",
      "",
      "# mutable-shared",
    ].join("\n"),
  );

  const cached = await buildClientSkillsPayload(options);
  expect(cached.clientSkills).toEqual(initial.clientSkills);

  invalidateClientSkillsPayloadCacheForAgent(AGENT_ID);
  const refreshed = await buildClientSkillsPayload(options);
  expect(
    refreshed.clientSkills.find((skill) => skill.name === "mutable-shared")
      ?.description,
  ).toBe("Updated description");
});

test("does not load attached shared skills for local agents", async () => {
  const localAgentId = "agent-local-shared-skills-test";
  const localMount = join(
    tempHome,
    ".letta",
    "agents",
    localAgentId,
    "shared-team",
    "skills",
  );
  await createSkill(localMount, "cloud-only-shared", "Cloud-only skill");

  const result = await buildClientSkillsPayload({
    ...buildOptions([{ id: "repo-1", name: "shared-team" }]),
    agentId: localAgentId,
  });

  expect(result.clientSkills.map((skill) => skill.name)).not.toContain(
    "cloud-only-shared",
  );
});

test("rejects unsafe attached repository names before resolving a mount", async () => {
  const result = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-unsafe", name: "../outside" }]),
  );

  expect(result.clientSkills).toEqual([]);
  expect(result.errors).toContainEqual({
    path: "shared-memory:../outside",
    message:
      "repository name can only contain letters, numbers, dots, underscores, and hyphens",
  });
});

test("does not reuse attachment resolution errors after the list recovers", async () => {
  const failed = await buildClientSkillsPayload(
    buildOptions([{ id: "repo-unsafe", name: "../outside" }]),
  );
  const recovered = await buildClientSkillsPayload(buildOptions([]));

  expect(failed.errors).toHaveLength(1);
  expect(recovered.errors).toEqual([]);
});
