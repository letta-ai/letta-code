import { join } from "node:path";
import {
  getCurrentAgentId,
  getCurrentClient,
  getSkillsDirectory,
} from "../../agent/context";
import { SKILLS_DIR } from "../../agent/skills";
import { read } from "./Read";
import { validateRequiredParams } from "./validation.js";

interface SkillArgs {
  skill: string;
}

interface SkillResult {
  message: string;
}

/**
 * Parse loaded_skills block content to extract skill IDs
 */
function parseLoadedSkills(value: string): string[] {
  const skillRegex = /# Skill: ([^\n]+)/g;
  const skills: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = skillRegex.exec(value)) !== null) {
    const skillId = match[1]?.trim();
    if (skillId) {
      skills.push(skillId);
    }
  }

  return skills;
}

/**
 * Extracts skills directory from skills block value
 */
function extractSkillsDir(skillsBlockValue: string): string | null {
  const match = skillsBlockValue.match(/Skills Directory: (.+)/);
  return match ? match[1]?.trim() || null : null;
}

export async function skill(args: SkillArgs): Promise<SkillResult> {
  validateRequiredParams(args, ["skill"], "Skill");
  const { skill: skillId } = args;

  try {
    // Get current agent context
    const client = getCurrentClient();
    const agentId = getCurrentAgentId();

    // Retrieve the agent to access memory blocks
    const agent = await client.agents.retrieve(agentId);

    // Find the loaded_skills block
    const loadedSkillsBlock = agent.memory_blocks?.find(
      (b) => b.label === "loaded_skills",
    );

    if (!loadedSkillsBlock?.id) {
      throw new Error(
        'Error: loaded_skills block not found. This block is required for the Skill tool to work.',
      );
    }

    // Determine skills directory
    let skillsDir = getSkillsDirectory();

    if (!skillsDir) {
      // Try to extract from skills block
      const skillsBlock = agent.memory_blocks?.find((b) => b.label === "skills");
      if (skillsBlock?.value) {
        skillsDir = extractSkillsDir(skillsBlock.value);
      }
    }

    if (!skillsDir) {
      // Fall back to default .skills directory in cwd
      skillsDir = join(process.cwd(), SKILLS_DIR);
    }

    // Construct path to SKILL.md
    const skillPath = join(skillsDir, skillId, "SKILL.md");

    // Read the skill file using the Read tool
    const skillContent = await read({ file_path: skillPath });

    // Parse current loaded_skills block value
    const currentValue = loadedSkillsBlock.value || "";
    const loadedSkills = parseLoadedSkills(currentValue);

    // Check if skill is already loaded
    if (loadedSkills.includes(skillId)) {
      return {
        message: `Skill "${skillId}" is already loaded`,
      };
    }

    // Append new skill to loaded_skills block
    const separator = currentValue ? "\n\n---\n\n" : "";
    const newValue = `${currentValue}${separator}# Skill: ${skillId}\n${skillContent.content}`;

    // Update the block using client.blocks.modify()
    await client.blocks.modify(loadedSkillsBlock.id, {
      value: newValue,
    });

    return {
      message: `Skill "${skillId}" loaded successfully`,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to load skill: ${String(error)}`);
  }
}
