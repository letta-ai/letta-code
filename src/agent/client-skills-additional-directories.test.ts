import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import type { SkillDiscoveryResult } from "@/agent/skills";

test("combines the configured directory with per-turn skill directories", async () => {
  const discoveredPaths: string[] = [];
  const discoverSkillsFn = async (path = ""): Promise<SkillDiscoveryResult> => {
    discoveredPaths.push(path);
    const id = path.includes("cloud-skills")
      ? "browser-use"
      : path.includes("repo-a")
        ? "repo-a-skill"
        : path.includes("repo-b")
          ? "repo-b-skill"
          : null;
    return {
      skills: id
        ? [
            {
              id,
              name: id,
              description: id,
              path: join(path, id, "SKILL.md"),
              source: "project",
            },
          ]
        : [],
      errors: [],
    };
  };

  const result = await buildClientSkillsPayload({
    skillsDirectory: "/root/.letta/cloud-skills",
    additionalSkillDirectories: [
      "/root/workspace/repo-a/.agents/skills",
      "/root/workspace/repo-b/.agents/skills",
      "/root/workspace/repo-a/.agents/skills",
    ],
    skillSources: ["project"],
    discoverSkillsFn,
  });

  expect(result.clientSkills.map((skill) => skill.name)).toEqual([
    "browser-use",
    "repo-a-skill",
    "repo-b-skill",
  ]);
  expect(
    discoveredPaths.filter((path) => path.includes("repo-a")),
  ).toHaveLength(1);
});
