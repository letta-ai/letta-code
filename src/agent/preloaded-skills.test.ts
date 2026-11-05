import { expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreloadedSkills } from "./preloaded-skills";

test("preload reads selected skill files in requested order and skips unavailable files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preload-"));
  try {
    await writeFile(join(dir, "a.md"), "Skill A");
    await writeFile(join(dir, "b.md"), "Skill B");
    const result = await loadPreloadedSkills(
      ["b", "a", "missing", "unreadable"],
      {
        workingDirectory: dir,
        skillsDirectory: dir,
        skillSources: ["project"],
        attachedRepositories: [],
        discoverSkillsFn: async () => ({
          skills: ["a", "b", "unreadable"].map((id) => ({
            id,
            name: id,
            description: id,
            path: join(dir, `${id}.md`),
            source: "project" as const,
          })),
          errors: [],
        }),
      },
    );
    expect(result).toBe(
      "<loaded_skills>\n<b>\nSkill B\n</b>\n\n<a>\nSkill A\n</a>\n</loaded_skills>",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn without configured preloads does not perform skill discovery", async () => {
  const discoverSkillsFn = mock(async () => ({ skills: [], errors: [] }));
  expect(await loadPreloadedSkills([], { discoverSkillsFn })).toBe("");
  expect(discoverSkillsFn).not.toHaveBeenCalled();
});

test("preload reads allowlisted bundled skills from the runtime scope", async () => {
  const { runWithRuntimeContext } = await import("@/runtime-context");
  const dir = await mkdtemp(join(tmpdir(), "preload-bundled-"));
  try {
    const result = await runWithRuntimeContext(
      {
        skillSources: ["project"],
        bundledSkills: ["maintaining-deferred-memory"],
      },
      () =>
        loadPreloadedSkills(
          ["maintaining-deferred-memory", "maintaining-core-memory"],
          {
            workingDirectory: dir,
            skillsDirectory: null,
            attachedRepositories: [],
          },
        ),
    );
    expect(result).toContain("<maintaining-deferred-memory>\n");
    expect(result).not.toContain("<maintaining-core-memory>");
    const { buildClientSkillsPayload } = await import("@/agent/client-skills");
    const discovered = await buildClientSkillsPayload({
      workingDirectory: dir,
      skillsDirectory: null,
      skillSources: ["project"],
      bundledSkills: ["maintaining-core-memory"],
      attachedRepositories: [],
    });
    expect(discovered.clientSkills.map((skill) => skill.name)).toEqual([
      "maintaining-core-memory",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
