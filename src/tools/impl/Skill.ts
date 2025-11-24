import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getCurrentAgentId,
  getCurrentClient,
  getSkillsDirectory,
  setHasLoadedSkills,
} from "../../agent/context";
import { SKILLS_DIR } from "../../agent/skills";
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
  let match: RegExpExecArray | null = skillRegex.exec(value);

  while (match !== null) {
    const skillId = match[1]?.trim();
    if (skillId) {
      skills.push(skillId);
    }
    match = skillRegex.exec(value);
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

    // Retrieve the loaded_skills block directly
    let loadedSkillsBlock: Awaited<
      ReturnType<typeof client.agents.blocks.retrieve>
    >;
    try {
      loadedSkillsBlock = await client.agents.blocks.retrieve("loaded_skills", {
        agent_id: agentId,
      });
    } catch (error) {
      throw new Error(
        `Error: loaded_skills block not found. This block is required for the Skill tool to work.\nAgent ID: ${agentId}\nError: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Determine skills directory
    let skillsDir = getSkillsDirectory();

    if (!skillsDir) {
      // Try to extract from skills block
      try {
        const skillsBlock = await client.agents.blocks.retrieve("skills", {
          agent_id: agentId,
        });
        if (skillsBlock?.value) {
          skillsDir = extractSkillsDir(skillsBlock.value);
        }
      } catch {
        // Skills block doesn't exist, will fall back to default
      }
    }

    if (!skillsDir) {
      // Fall back to default .skills directory in cwd
      skillsDir = join(process.cwd(), SKILLS_DIR);
    }

    // Construct path to SKILL.md
    const skillPath = join(skillsDir, skillId, "SKILL.md");

    // Read the skill file directly
    const skillContent = await readFile(skillPath, "utf-8");

    // Parse current loaded_skills block value
    let currentValue = loadedSkillsBlock.value?.trim() || "";
    const loadedSkills = parseLoadedSkills(currentValue);

    // Check if skill is already loaded
    if (loadedSkills.includes(skillId)) {
      return {
        message: `Skill "${skillId}" is already loaded`,
      };
    }

    // Replace placeholder if this is the first skill
    if (currentValue === "[CURRENTLY EMPTY]") {
      currentValue = "";
    }

    // Append new skill to loaded_skills block
    const separator = currentValue ? "\n\n---\n\n" : "";
    const newValue = `${currentValue}${separator}# Skill: ${skillId}\n${skillContent}`;

    // Update the block using client.blocks.modify()
    await client.blocks.modify(loadedSkillsBlock.id, {
      value: newValue,
    });

    // Update the cached flag to indicate skills are loaded
    setHasLoadedSkills(true);

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
