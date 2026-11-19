import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { runWithRuntimeContext } from "@/runtime-context";
import { cloudRepositoryRoots } from "@/utils/cloud-repository-roots";

test("Letta discovers canonical and legacy skills from every sandbox repository", async () => {
  const names = ["web", "api"];
  const [web, api] = cloudRepositoryRoots(names) as [string, string];
  const paths = new Map([
    [join(web, ".agents", "skills"), "web-skill"],
    [join(api, ".skills"), "api-skill"],
  ]);
  const result = await runWithRuntimeContext(
    {
      executionSettings: {
        allowed_tools: [],
        disallowed_tools: [],
        disable_memory_guard: false,
        cloud_skill_repositories: names,
      },
    },
    () =>
      buildClientSkillsPayload({
        skillSources: ["project"],
        attachedRepositories: [],
        discoverSkillsFn: async (root) => {
          const id = root && paths.get(root);
          return {
            errors: [],
            skills: id
              ? [
                  {
                    id,
                    name: id,
                    source: "project",
                    description: id,
                    path: join(root, id, "SKILL.md"),
                  },
                ]
              : [],
          };
        },
      }),
  );
  expect(result.clientSkills?.map(({ name }) => name)).toEqual([
    "api-skill",
    "web-skill",
  ]);
});
