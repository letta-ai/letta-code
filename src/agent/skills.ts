/**
 * Skills module - provides skill discovery and management functionality
 *
 * Skills are discovered from three sources (in order of priority):
 * 1. Project skills: .skills/ in current directory (highest priority - overrides)
 * 2. Global skills: ~/.letta/skills/ for user's personal skills
 * 3. Bundled skills: embedded in package (lowest priority - defaults)
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
// Import bundled skills (embedded at build time)
import memoryInitSkillMd from "../skills/builtin/memory-init/SKILL.md";
import { parseFrontmatter } from "../utils/frontmatter";

/**
 * Bundled skill sources - embedded at build time
 */
const BUNDLED_SKILL_SOURCES: Array<{ id: string; content: string }> = [
  { id: "memory-init", content: memoryInitSkillMd },
];

/**
 * Source of a skill (for display and override resolution)
 */
export type SkillSource = "bundled" | "global" | "project";

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
  /** Path to the skill file (empty for bundled skills) */
  path: string;
  /** Source of the skill */
  source: SkillSource;
  /** Raw content of the skill (for bundled skills) */
  content?: string;
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
 * Default directory name where project skills are stored
 */
export const SKILLS_DIR = ".skills";

/**
 * Global skills directory (in user's home directory)
 */
export const GLOBAL_SKILLS_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".letta/skills",
);

/**
 * Skills block character limit.
 * If formatted skills exceed this, fall back to compact tree format.
 */
const SKILLS_BLOCK_CHAR_LIMIT = 20000;

/**
 * Parse a bundled skill from its embedded content
 */
function parseBundledSkill(id: string, content: string): Skill {
  const { frontmatter, body } = parseFrontmatter(content);

  const name =
    (typeof frontmatter.name === "string" ? frontmatter.name : null) ||
    id
      .split("/")
      .pop()
      ?.replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase()) ||
    id;

  let description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : null;
  if (!description) {
    const firstParagraph = body.trim().split("\n\n")[0];
    description = firstParagraph || "No description available";
  }

  // Strip surrounding quotes
  description = description.trim();
  if (
    (description.startsWith('"') && description.endsWith('"')) ||
    (description.startsWith("'") && description.endsWith("'"))
  ) {
    description = description.slice(1, -1);
  }

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
    path: "", // Bundled skills don't have a file path
    source: "bundled",
    content, // Store the full content for bundled skills
  };
}

/**
 * Get bundled skills (embedded at build time)
 */
export function getBundledSkills(): Skill[] {
  return BUNDLED_SKILL_SOURCES.map(({ id, content }) =>
    parseBundledSkill(id, content),
  );
}

/**
 * Discovers skills from a single directory
 * @param skillsPath - The directory to search for skills
 * @param source - The source type for skills in this directory
 * @returns A result containing discovered skills and any errors
 */
async function discoverSkillsFromDir(
  skillsPath: string,
  source: SkillSource,
): Promise<SkillDiscoveryResult> {
  const errors: SkillDiscoveryError[] = [];

  // Check if skills directory exists
  if (!existsSync(skillsPath)) {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];

  try {
    // Recursively find all SKILL.MD files
    await findSkillFiles(skillsPath, skillsPath, skills, errors, source);
  } catch (error) {
    errors.push({
      path: skillsPath,
      message: `Failed to read skills directory: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { skills, errors };
}

/**
 * Discovers skills from all sources (bundled, global, project)
 * Later sources override earlier ones with the same ID.
 *
 * Priority order (highest to lowest):
 * 1. Project skills (.skills/ in current directory)
 * 2. Global skills (~/.letta/skills/)
 * 3. Bundled skills (embedded in package)
 *
 * @param projectSkillsPath - The project skills directory (default: .skills in current directory)
 * @returns A result containing discovered skills and any errors
 */
export async function discoverSkills(
  projectSkillsPath: string = join(process.cwd(), SKILLS_DIR),
): Promise<SkillDiscoveryResult> {
  const allErrors: SkillDiscoveryError[] = [];
  const skillsById = new Map<string, Skill>();

  // 1. Start with bundled skills (lowest priority)
  for (const skill of getBundledSkills()) {
    skillsById.set(skill.id, skill);
  }

  // 2. Add global skills (override bundled)
  const globalResult = await discoverSkillsFromDir(GLOBAL_SKILLS_DIR, "global");
  allErrors.push(...globalResult.errors);
  for (const skill of globalResult.skills) {
    skillsById.set(skill.id, skill);
  }

  // 3. Add project skills (override global and bundled)
  const projectResult = await discoverSkillsFromDir(
    projectSkillsPath,
    "project",
  );
  allErrors.push(...projectResult.errors);
  for (const skill of projectResult.skills) {
    skillsById.set(skill.id, skill);
  }

  return {
    skills: Array.from(skillsById.values()),
    errors: allErrors,
  };
}

/**
 * Recursively searches for SKILL.MD files in a directory
 * @param currentPath - The current directory being searched
 * @param rootPath - The root skills directory
 * @param skills - Array to collect found skills
 * @param errors - Array to collect errors
 * @param source - The source type for skills in this directory
 */
async function findSkillFiles(
  currentPath: string,
  rootPath: string,
  skills: Skill[],
  errors: SkillDiscoveryError[],
  source: SkillSource,
): Promise<void> {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively search subdirectories
        await findSkillFiles(fullPath, rootPath, skills, errors, source);
      } else if (entry.isFile() && entry.name.toUpperCase() === "SKILL.MD") {
        // Found a SKILL.MD file
        try {
          const skill = await parseSkillFile(fullPath, rootPath, source);
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
 * @param source - The source type for this skill
 * @returns A Skill object or null if parsing fails
 */
async function parseSkillFile(
  filePath: string,
  rootPath: string,
  source: SkillSource,
): Promise<Skill | null> {
  const content = await readFile(filePath, "utf-8");

  // Parse frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // Derive ID from directory structure relative to root
  // E.g., .skills/data-analysis/SKILL.MD -> "data-analysis"
  // E.g., .skills/web/scraper/SKILL.MD -> "web/scraper"
  // Normalize rootPath to not have trailing slash
  const normalizedRoot = rootPath.endsWith("/")
    ? rootPath.slice(0, -1)
    : rootPath;
  const relativePath = filePath.slice(normalizedRoot.length + 1); // +1 to remove leading slash
  const dirPath = relativePath.slice(0, -"/SKILL.MD".length);
  const defaultId = dirPath || "root";

  const id =
    (typeof frontmatter.id === "string" ? frontmatter.id : null) || defaultId;

  // Use name from frontmatter or derive from ID
  const name =
    (typeof frontmatter.name === "string" ? frontmatter.name : null) ||
    (typeof frontmatter.title === "string" ? frontmatter.title : null) ||
    (id.split("/").pop() ?? "")
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

  // Strip surrounding quotes from description if present
  description = description.trim();
  if (
    (description.startsWith('"') && description.endsWith('"')) ||
    (description.startsWith("'") && description.endsWith("'"))
  ) {
    description = description.slice(1, -1);
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
    source,
  };
}

/**
 * Formats skills as a compact directory tree structure
 * @param skills - Array of discovered skills
 * @param skillsDirectory - Absolute path to the skills directory
 * @returns Tree-structured string representation
 */
function formatSkillsAsTree(skills: Skill[], skillsDirectory: string): string {
  let output = `Skills Directory: ${skillsDirectory}\n\n`;

  if (skills.length === 0) {
    return `${output}[NO SKILLS AVAILABLE]`;
  }

  output += `Note: Many skills available - showing directory structure only. For each skill path shown below, you can either:\n`;
  output += `- Load it persistently into memory using the path (e.g., "ai/tools/mcp-builder")\n`;
  output += `- Read ${skillsDirectory}/{path}/SKILL.md directly to preview without loading\n\n`;

  // Build tree structure from skill IDs
  interface TreeNode {
    [key: string]: TreeNode | null;
  }

  const tree: TreeNode = {};

  // Parse all skill IDs into tree structure
  for (const skill of skills) {
    const parts = skill.id.split("/");
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      // Last part is the skill name (leaf node)
      if (i === parts.length - 1) {
        current[part] = null;
      } else {
        // Intermediate directory
        if (!current[part]) {
          current[part] = {};
        }
        current = current[part] as TreeNode;
      }
    }
  }

  // Render tree with indentation
  function renderTree(node: TreeNode, indent: string = ""): string {
    let result = "";
    const entries = Object.entries(node).sort(([a], [b]) => a.localeCompare(b));

    for (const [name, children] of entries) {
      if (children === null) {
        // Leaf node (skill)
        result += `${indent}${name}\n`;
      } else {
        // Directory node
        result += `${indent}${name}/\n`;
        result += renderTree(children, `${indent}  `);
      }
    }

    return result;
  }

  output += renderTree(tree);

  return output.trim();
}

/**
 * Formats discovered skills with full metadata
 * @param skills - Array of discovered skills
 * @param skillsDirectory - Absolute path to the skills directory
 * @returns Full metadata string representation
 */
function formatSkillsWithMetadata(
  skills: Skill[],
  skillsDirectory: string,
): string {
  let output = `Skills Directory: ${skillsDirectory}\n`;
  output += `Global Skills Directory: ${GLOBAL_SKILLS_DIR}\n\n`;

  if (skills.length === 0) {
    return `${output}[NO SKILLS AVAILABLE]`;
  }

  output += "Available Skills:\n";
  output +=
    "(source: bundled = built-in to Letta Code, global = ~/.letta/skills/, project = .skills/)\n\n";

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
  let output = `### ${skill.name} (${skill.source})\n`;
  output += `ID: \`${skill.id}\`\n`;
  output += `Description: ${skill.description}\n`;

  if (skill.tags && skill.tags.length > 0) {
    output += `Tags: ${skill.tags.map((t) => `\`${t}\``).join(", ")}\n`;
  }

  output += "\n";
  return output;
}

/**
 * Formats discovered skills as a string for the skills memory block.
 * Tries full metadata format first, falls back to compact tree if it exceeds limit.
 * @param skills - Array of discovered skills
 * @param skillsDirectory - Absolute path to the skills directory
 * @returns Formatted string representation of skills
 */
export function formatSkillsForMemory(
  skills: Skill[],
  skillsDirectory: string,
): string {
  // Handle empty case
  if (skills.length === 0) {
    return `Skills Directory: ${skillsDirectory}\n\n[NO SKILLS AVAILABLE]`;
  }

  // Try full metadata format first
  const fullFormat = formatSkillsWithMetadata(skills, skillsDirectory);

  // If within limit, use full format
  if (fullFormat.length <= SKILLS_BLOCK_CHAR_LIMIT) {
    return fullFormat;
  }

  // Otherwise fall back to compact tree format
  return formatSkillsAsTree(skills, skillsDirectory);
}
