import { readFile } from "node:fs/promises";
import { wrapSkillContent } from "@/tools/impl/skill";
import { buildClientSkillsPayload } from "./client-skills";

export async function loadPreloadedSkills(
  ids: string[],
  options: Parameters<typeof buildClientSkillsPayload>[0] = {},
): Promise<{ content: string; missingIds: string[] }> {
  if (ids.length === 0) return { content: "", missingIds: [] };
  const { skillPathById } = await buildClientSkillsPayload({
    ...options,
    skillSources:
      options.skillSources?.length === 0 ? ["bundled"] : options.skillSources,
  });
  const contents: string[] = [];
  const missingIds: string[] = [];
  for (const id of ids) {
    const path = skillPathById[id];
    if (path) {
      try {
        contents.push(wrapSkillContent(id, await readFile(path, "utf-8")));
        continue;
      } catch {}
    }
    missingIds.push(id);
  }
  return { content: contents.join("\n\n"), missingIds };
}
