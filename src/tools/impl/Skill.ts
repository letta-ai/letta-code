import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getClient } from "../../agent/client";
import {
  getCurrentAgentId,
  getSkillsDirectory,
  setHasLoadedSkills,
} from "../../agent/context";
import {
  discoverSkills,
  formatSkillsForMemory,
  SKILLS_DIR,
} from "../../agent/skills";
import { validateRequiredParams } from "./validation.js";

interface SkillArgs {
  command: "load" | "unload" | "refresh";
  skills?: string[];
}

interface SkillResult {
  message: string;
}

/**
 * Parse loaded_skills block content to extract skill IDs and their content boundaries
 */
function parseLoadedSkills(
  value: string,
): Map<string, { start: number; end: number }> {
  const skillMap = new Map<string, { start: number; end: number }>();
  const skillHeaderRegex = /# Skill: ([^\n]+)/g;

  const headers: { id: string; start: number }[] = [];

  // Find all skill headers
  let match = skillHeaderRegex.exec(value);
  while (match !== null) {
    const skillId = match[1]?.trim();
    if (skillId) {
      headers.push({ id: skillId, start: match.index });
    }
    match = skillHeaderRegex.exec(value);
  }

  // Determine boundaries for each skill
  for (let i = 0; i < headers.length; i++) {
    const current = headers[i];
    const next = headers[i + 1];

    if (!current) continue;

    let end: number;
    if (next) {
      // Find the separator before the next skill
      const searchStart = current.start;
      const searchEnd = next.start;
      const substring = value.substring(searchStart, searchEnd);
      const sepMatch = substring.lastIndexOf("\n\n---\n\n");
      if (sepMatch !== -1) {
        end = searchStart + sepMatch;
      } else {
        end = searchEnd;
      }
    } else {
      end = value.length;
    }

    skillMap.set(current.id, { start: current.start, end });
  }

  return skillMap;
}

/**
 * Get list of loaded skill IDs
 */
function getLoadedSkillIds(value: string): string[] {
  const skillRegex = /# Skill: ([^\n]+)/g;
  const skills: string[] = [];

  let match = skillRegex.exec(value);
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

/**
 * Read skill content from file
 */
async function readSkillContent(
  skillId: string,
  skillsDir: string,
): Promise<string> {
  // Try primary skills directory
  const skillPath = join(skillsDir, skillId, "SKILL.md");

  try {
    return await readFile(skillPath, "utf-8");
  } catch (primaryError) {
    // Fallback: check for bundled skills in a repo-level skills directory
    try {
      const bundledSkillsDir = join(process.cwd(), "skills", "skills");
      const bundledSkillPath = join(bundledSkillsDir, skillId, "SKILL.md");
      return await readFile(bundledSkillPath, "utf-8");
    } catch {
      // If bundled fallback also fails, rethrow the original error
      throw primaryError;
    }
  }
}

/**
 * Get skills directory, trying multiple sources
 */
async function getResolvedSkillsDir(
  client: Awaited<ReturnType<typeof getClient>>,
  agentId: string,
): Promise<string> {
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

  return skillsDir;
}

export async function skill(args: SkillArgs): Promise<SkillResult> {
  validateRequiredParams(args, ["command"], "Skill");
  const { command, skills: skillIds } = args;

  if (command !== "load" && command !== "unload" && command !== "refresh") {
    throw new Error(
      `Invalid command "${command}". Must be "load", "unload", or "refresh".`,
    );
  }

  // For load/unload, skills array is required
  if (command !== "refresh") {
    if (!Array.isArray(skillIds) || skillIds.length === 0) {
      throw new Error(
        `Skill tool requires a non-empty 'skills' array for "${command}" command`,
      );
    }
  }

  try {
    // Get current agent context
    const client = await getClient();
    const agentId = getCurrentAgentId();

    // Handle refresh command
    if (command === "refresh") {
      const skillsDir = await getResolvedSkillsDir(client, agentId);

      // Discover skills from directory
      const { skills, errors } = await discoverSkills(skillsDir);

      // Log any errors
      if (errors.length > 0) {
        for (const error of errors) {
          console.warn(
            `Skill discovery error: ${error.path}: ${error.message}`,
          );
        }
      }

      // Format and update the skills block
      const formattedSkills = formatSkillsForMemory(skills, skillsDir);
      await client.agents.blocks.update("skills", {
        agent_id: agentId,
        value: formattedSkills,
      });

      return {
        message: `Refreshed skills list: found ${skills.length} skill(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ""}`,
      };
    }

    // Retrieve the loaded_skills block for load/unload
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

    const skillsDir = await getResolvedSkillsDir(client, agentId);

    let currentValue = loadedSkillsBlock.value?.trim() || "";
    const loadedSkillIds = getLoadedSkillIds(currentValue);
    const results: string[] = [];

    // skillIds is guaranteed to be non-empty for load/unload (validated above)
    const skillsToProcess = skillIds as string[];

    if (command === "load") {
      // Load skills
      for (const skillId of skillsToProcess) {
        if (loadedSkillIds.includes(skillId)) {
          results.push(`"${skillId}" already loaded`);
          continue;
        }

        try {
          const skillContent = await readSkillContent(skillId, skillsDir);

          // Replace placeholder if this is the first skill
          if (currentValue === "[CURRENTLY EMPTY]") {
            currentValue = "";
          }

          // Append new skill
          const separator = currentValue ? "\n\n---\n\n" : "";
          currentValue = `${currentValue}${separator}# Skill: ${skillId}\n${skillContent}`;
          loadedSkillIds.push(skillId);
          results.push(`"${skillId}" loaded`);
        } catch (error) {
          results.push(
            `"${skillId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Update the block
      await client.agents.blocks.update("loaded_skills", {
        agent_id: agentId,
        value: currentValue,
      });

      // Update the cached flag
      if (loadedSkillIds.length > 0) {
        setHasLoadedSkills(true);
      }
    } else {
      // Unload skills
      const skillBoundaries = parseLoadedSkills(currentValue);

      // Sort skills to unload by their position (descending) so we can remove from end first
      const sortedSkillsToUnload = skillsToProcess
        .filter((id) => skillBoundaries.has(id))
        .sort((a, b) => {
          const boundaryA = skillBoundaries.get(a);
          const boundaryB = skillBoundaries.get(b);
          return (boundaryB?.start || 0) - (boundaryA?.start || 0);
        });

      for (const skillId of skillsToProcess) {
        if (!loadedSkillIds.includes(skillId)) {
          results.push(`"${skillId}" not loaded`);
          continue;
        }
        results.push(`"${skillId}" unloaded`);
      }

      // Remove skills from content (in reverse order to maintain indices)
      for (const skillId of sortedSkillsToUnload) {
        const boundary = skillBoundaries.get(skillId);
        if (boundary) {
          // Check if there's a separator before this skill
          const beforeStart = boundary.start;
          let actualStart = beforeStart;

          // Look for preceding separator
          const precedingSep = "\n\n---\n\n";
          if (beforeStart >= precedingSep.length) {
            const potentialSep = currentValue.substring(
              beforeStart - precedingSep.length,
              beforeStart,
            );
            if (potentialSep === precedingSep) {
              actualStart = beforeStart - precedingSep.length;
            }
          }

          // Remove the skill content
          currentValue =
            currentValue.substring(0, actualStart) +
            currentValue.substring(boundary.end);
        }
      }

      // Clean up the value
      currentValue = currentValue.trim();
      if (currentValue === "") {
        currentValue = "[CURRENTLY EMPTY]";
      }

      // Update the block
      await client.agents.blocks.update("loaded_skills", {
        agent_id: agentId,
        value: currentValue,
      });

      // Update the cached flag
      const remainingSkills = getLoadedSkillIds(currentValue);
      setHasLoadedSkills(remainingSkills.length > 0);
    }

    return {
      message: results.join(", "),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to ${command} skill(s): ${String(error)}`);
  }
}
