import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCurrentAgentId, getSkillsDirectory } from "../../agent/context";
import {
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  getBundledSkills,
  SKILLS_DIR,
} from "../../agent/skills";
import { queueSkillContent } from "./skillContentRegistry";
import { validateRequiredParams } from "./validation.js";

interface SkillArgs {
  skill: string;
  args?: string;
  /** Injected by executeTool - the tool_call_id for this invocation */
  toolCallId?: string;
}

interface SkillResult {
  message: string;
}

/**
 * Check if a skill directory has additional files beyond SKILL.md
 */
function hasAdditionalFiles(skillMdPath: string): boolean {
  try {
    const skillDir = dirname(skillMdPath);
    const entries = readdirSync(skillDir);
    return entries.some((e) => e.toUpperCase() !== "SKILL.MD");
  } catch {
    return false;
  }
}

/**
 * Read skill content from file or bundled source
 * Returns both content and the path to the SKILL.md file
 *
 * Search order (highest priority first):
 * 1. Project skills (.skills/)
 * 2. Agent skills (~/.letta/agents/{id}/skills/)
 * 3. Global skills (~/.letta/skills/)
 * 4. Bundled skills
 */
async function readSkillContent(
  skillId: string,
  skillsDir: string,
  agentId?: string,
): Promise<{ content: string; path: string }> {
  // 1. Try project skills directory (highest priority)
  const projectSkillPath = join(skillsDir, skillId, "SKILL.md");
  try {
    const content = await readFile(projectSkillPath, "utf-8");
    return { content, path: projectSkillPath };
  } catch {
    // Not in project, continue
  }

  // 2. Try agent skills directory (if agentId provided)
  if (agentId) {
    const agentSkillPath = join(
      getAgentSkillsDir(agentId),
      skillId,
      "SKILL.md",
    );
    try {
      const content = await readFile(agentSkillPath, "utf-8");
      return { content, path: agentSkillPath };
    } catch {
      // Not in agent dir, continue
    }
  }

  // 3. Try global skills directory
  const globalSkillPath = join(GLOBAL_SKILLS_DIR, skillId, "SKILL.md");
  try {
    const content = await readFile(globalSkillPath, "utf-8");
    return { content, path: globalSkillPath };
  } catch {
    // Not in global, continue
  }

  // 4. Try bundled skills (lowest priority)
  const bundledSkills = await getBundledSkills();
  const bundledSkill = bundledSkills.find((s) => s.id === skillId);
  if (bundledSkill?.path) {
    try {
      const content = await readFile(bundledSkill.path, "utf-8");
      return { content, path: bundledSkill.path };
    } catch {
      // Bundled skill path not found, continue to legacy fallback
    }
  }

  // Legacy fallback: check for bundled skills in a repo-level skills directory
  {
    try {
      const bundledSkillsDir = join(process.cwd(), "skills", "skills");
      const bundledSkillPath = join(bundledSkillsDir, skillId, "SKILL.md");
      const content = await readFile(bundledSkillPath, "utf-8");
      return { content, path: bundledSkillPath };
    } catch {
      throw new Error(
        `Skill "${skillId}" not found. Check that the skill name is correct and that it appears in the available skills list.`,
      );
    }
  }
}

/**
 * Get skills directory, trying multiple sources
 */
async function getResolvedSkillsDir(): Promise<string> {
  const skillsDir = getSkillsDirectory();

  if (skillsDir) {
    return skillsDir;
  }

  // Fall back to default .skills directory in cwd
  return join(process.cwd(), SKILLS_DIR);
}

export async function skill(args: SkillArgs): Promise<SkillResult> {
  validateRequiredParams(args, ["skill"], "Skill");
  const { skill: skillName, toolCallId } = args;

  if (!skillName || typeof skillName !== "string") {
    throw new Error(
      'Invalid skill name. The "skill" parameter must be a non-empty string.',
    );
  }

  try {
    const agentId = getCurrentAgentId();
    const skillsDir = await getResolvedSkillsDir();

    // Read the SKILL.md content
    const { content: skillContent, path: skillPath } = await readSkillContent(
      skillName,
      skillsDir,
      agentId,
    );

    // Process the content: replace <SKILL_DIR> placeholder if skill has additional files
    const skillDir = dirname(skillPath);
    const hasExtras = hasAdditionalFiles(skillPath);
    const processedContent = hasExtras
      ? skillContent.replace(/<SKILL_DIR>/g, skillDir)
      : skillContent;

    // Build the full content with skill directory info if applicable
    const dirHeader = hasExtras ? `# Skill Directory: ${skillDir}\n\n` : "";
    const fullContent = `${dirHeader}${processedContent}`;

    // Queue the skill content for harness-level injection as a user message part
    if (toolCallId) {
      queueSkillContent(toolCallId, fullContent);
    }

    return { message: `Launching skill: ${skillName}` };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to invoke skill "${skillName}": ${String(error)}`);
  }
}
