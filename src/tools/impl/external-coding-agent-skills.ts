import { resolve } from "node:path";
import { discoverClientSideSkills } from "@/agent/client-skills";
import { getSkillSources } from "@/agent/context";
import {
  compareSkills,
  isModelInvocableSkill,
  type Skill,
} from "@/agent/skills";
import { getMcpScopeAgentId } from "@/mcp-scope";

/** Keep the launch prompt bounded without truncating a skill's file path. */
export function buildExternalCodingAgentSkillsReminder(
  skills: Skill[],
): string | undefined {
  const lines: string[] = [];
  let size = 0;
  for (const skill of [...skills].sort(compareSkills)) {
    if (
      skill.source === "bundled" ||
      !skill.path ||
      !isModelInvocableSkill(skill)
    )
      continue;
    const line = `- ${skill.id}: ${skill.description}\n  SKILL.md: ${resolve(skill.path)}`;
    if (lines.length >= 100 || size + line.length > 32_000) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (!lines.length) return undefined;
  return `<system-reminder>
The following skills are available. Read the relevant SKILL.md before using a skill; resolve its referenced files relative to that file's directory.

${lines.join("\n")}
</system-reminder>`;
}

/** Use the same parent scope and skill roots as Letta Code, independently of MCP settings. */
export async function resolveExternalCodingAgentSkillsReminder(
  parentAgentId: string,
  workingDirectory?: string,
  deps: {
    getScopeAgentId?: typeof getMcpScopeAgentId;
    discoverSkills?: typeof discoverClientSideSkills;
  } = {},
): Promise<string | undefined> {
  try {
    const agentId = await (deps.getScopeAgentId ?? getMcpScopeAgentId)(
      parentAgentId,
    );
    const discovery = await (deps.discoverSkills ?? discoverClientSideSkills)({
      agentId,
      workingDirectory,
      skillSources: getSkillSources().filter((source) => source !== "bundled"),
    });
    return buildExternalCodingAgentSkillsReminder(discovery.skills);
  } catch {
    // Skill forwarding is optional; never widen access on broken parent linkage.
    return undefined;
  }
}
