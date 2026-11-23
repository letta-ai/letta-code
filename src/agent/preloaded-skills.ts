import { readFile } from "node:fs/promises";
import { buildClientSkillsPayload } from "./client-skills";

export async function loadPreloadedSkills(
  ids: string[],
  options: Parameters<typeof buildClientSkillsPayload>[0] = {},
): Promise<string> {
  if (ids.length === 0) return "";
  const { skillPathById } = await buildClientSkillsPayload({
    ...options,
    skillSources:
      options.skillSources?.length === 0 ? ["bundled"] : options.skillSources,
  });
  const contents: string[] = [];
  for (const id of ids) {
    const path = skillPathById[id];
    if (!path) continue;
    try {
      contents.push(`<${id}>\n${await readFile(path, "utf-8")}\n</${id}>`);
    } catch {}
  }
  return contents.length
    ? `<loaded_skills>\n${contents.join("\n\n")}\n</loaded_skills>`
    : "";
}
