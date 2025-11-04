/**
 * Skills module - provides skill discovery and management functionality
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Represents a skill that can be used by the agent
 */
export interface Skill {
  /** Unique identifier for the skill */
  id: string;
  /** Human-readable name of the skill */
  name: string;
  /** Description of what the skill does */
  description: string;
  /** Optional category for organizing skills */
  category?: string;
  /** Optional tags for filtering/searching skills */
  tags?: string[];
  /** Path to the skill file */
  path: string;
}

/**
 * Represents the result of skill discovery
 */
export interface SkillDiscoveryResult {
  /** List of discovered skills */
  skills: Skill[];
  /** Any errors encountered during discovery */
  errors: SkillDiscoveryError[];
}

/**
 * Represents an error that occurred during skill discovery
 */
export interface SkillDiscoveryError {
  /** Path where the error occurred */
  path: string;
  /** Error message */
  message: string;
}

/**
 * Default directory name where skills are stored
 */
export const SKILLS_DIR = ".skills";

/**
 * Parse frontmatter and content from a markdown file
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match || !match[1] || !match[2]) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, string | string[]> = {};

  // Parse YAML-like frontmatter (simple key: value pairs and arrays)
  const lines = frontmatterText.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of lines) {
    // Check if this is an array item
    if (line.trim().startsWith("-") && currentKey) {
      const value = line.trim().slice(1).trim();
      currentArray.push(value);
      continue;
    }

    // If we were building an array, save it
    if (currentKey && currentArray.length > 0) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = [];
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      currentKey = key;

      if (value) {
        // Simple key: value pair
        frontmatter[key] = value;
        currentKey = null;
      } else {
        // Might be starting an array
        currentArray = [];
      }
    }
  }

  // Save any remaining array
  if (currentKey && currentArray.length > 0) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Discovers skills by recursively searching for SKILL.MD files
 * @param skillsPath - The directory to search for skills (default: .skills in current directory)
 * @returns A result containing discovered skills and any errors
 */
export async function discoverSkills(
  skillsPath: string = join(process.cwd(), SKILLS_DIR)
): Promise<SkillDiscoveryResult> {
  const errors: SkillDiscoveryError[] = [];

  // Check if skills directory exists
  if (!existsSync(skillsPath)) {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];

  try {
    // Recursively find all SKILL.MD files
    await findSkillFiles(skillsPath, skillsPath, skills, errors);
  } catch (error) {
    errors.push({
      path: skillsPath,
      message: `Failed to read skills directory: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { skills, errors };
}

/**
 * Recursively searches for SKILL.MD files in a directory
 * @param currentPath - The current directory being searched
 * @param rootPath - The root skills directory
 * @param skills - Array to collect found skills
 * @param errors - Array to collect errors
 */
async function findSkillFiles(
  currentPath: string,
  rootPath: string,
  skills: Skill[],
  errors: SkillDiscoveryError[]
): Promise<void> {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively search subdirectories
        await findSkillFiles(fullPath, rootPath, skills, errors);
      } else if (entry.isFile() && entry.name.toUpperCase() === "SKILL.MD") {
        // Found a SKILL.MD file
        try {
          const skill = await parseSkillFile(fullPath, rootPath);
          if (skill) {
            skills.push(skill);
          }
        } catch (error) {
          errors.push({
            path: fullPath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } catch (error) {
    errors.push({
      path: currentPath,
      message: `Failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Parses a skill file and extracts metadata
 * @param filePath - Path to the skill file
 * @param rootPath - Root skills directory to derive relative path
 * @returns A Skill object or null if parsing fails
 */
async function parseSkillFile(
  filePath: string,
  rootPath: string
): Promise<Skill | null> {
  const file = Bun.file(filePath);
  const content = await file.text();

  // Parse frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // Derive ID from directory structure relative to root
  // E.g., .skills/data-analysis/SKILL.MD -> "data-analysis"
  // E.g., .skills/web/scraper/SKILL.MD -> "web/scraper"
  const relativePath = filePath.slice(rootPath.length + 1); // +1 to remove leading slash
  const dirPath = relativePath.slice(0, -"/SKILL.MD".length);
  const defaultId = dirPath || "root";

  const id =
    (typeof frontmatter.id === "string" ? frontmatter.id : null) || defaultId;

  // Use name from frontmatter or derive from ID
  const name =
    (typeof frontmatter.name === "string" ? frontmatter.name : null) ||
    (typeof frontmatter.title === "string" ? frontmatter.title : null) ||
    id
      .split("/")
      .pop()!
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());

  // Description is required - either from frontmatter or first paragraph of content
  let description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : null;
  if (!description) {
    // Extract first paragraph from content as description
    const firstParagraph = body.trim().split("\n\n")[0];
    description = firstParagraph || "No description available";
  }

  // Extract tags (handle both string and array)
  let tags: string[] | undefined;
  if (Array.isArray(frontmatter.tags)) {
    tags = frontmatter.tags;
  } else if (typeof frontmatter.tags === "string") {
    tags = [frontmatter.tags];
  }

  return {
    id,
    name,
    description,
    category:
      typeof frontmatter.category === "string"
        ? frontmatter.category
        : undefined,
    tags,
    path: filePath,
  };
}

/**
 * Formats discovered skills as a string for the skills memory block
 * @param skills - Array of discovered skills
 * @param skillsDirectory - Absolute path to the skills directory
 * @returns Formatted string representation of skills
 */
export function formatSkillsForMemory(skills: Skill[], skillsDirectory: string): string {
  let output = `Skills Directory: ${skillsDirectory}\n\n`;

  if (skills.length === 0) {
    return output + "[NO SKILLS AVAILABLE]";
  }

  output += "Available Skills:\n\n";

  // Group skills by category if categories exist
  const categorized = new Map<string, Skill[]>();
  const uncategorized: Skill[] = [];

  for (const skill of skills) {
    if (skill.category) {
      const existing = categorized.get(skill.category) || [];
      existing.push(skill);
      categorized.set(skill.category, existing);
    } else {
      uncategorized.push(skill);
    }
  }

  // Output categorized skills
  for (const [category, categorySkills] of categorized) {
    output += `## ${category}\n\n`;
    for (const skill of categorySkills) {
      output += formatSkill(skill);
    }
    output += "\n";
  }

  // Output uncategorized skills
  if (uncategorized.length > 0) {
    if (categorized.size > 0) {
      output += "## Other\n\n";
    }
    for (const skill of uncategorized) {
      output += formatSkill(skill);
    }
  }

  return output.trim();
}

/**
 * Formats a single skill for display
 */
function formatSkill(skill: Skill): string {
  let output = `### ${skill.name}\n`;
  output += `**ID:** \`${skill.id}\`\n`;
  output += `**Description:** ${skill.description}\n`;

  if (skill.tags && skill.tags.length > 0) {
    output += `**Tags:** ${skill.tags.map((t) => `\`${t}\``).join(", ")}\n`;
  }

  output += "\n";
  return output;
}
