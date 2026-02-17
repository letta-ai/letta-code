/**
 * Skills module - provides skill discovery and management functionality
 *
 * Skills are discovered from four sources (in order of priority):
 * 1. Project skills: .skills/ in current directory (highest priority - overrides)
 * 2. Agent skills: ~/.letta/agents/{agent-id}/skills/ for agent-specific skills
 * 3. Global skills: ~/.letta/skills/ for user's personal skills
 * 4. Bundled skills: embedded in package (lowest priority - defaults)
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../utils/frontmatter";
import { ALL_SKILL_SOURCES } from "./skillSources";

/**
 * Get the bundled skills directory path
 * This is where skills ship with the package (skills/ directory next to letta.js)
 */
function getBundledSkillsPath(): string {
  // In dev mode (running from src/), look in src/skills/builtin/
  // In production (running from letta.js), look in skills/ next to letta.js
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Check if we're in dev mode (thisDir contains 'src/agent')
  if (thisDir.includes("src/agent") || thisDir.includes("src\\agent")) {
    return join(thisDir, "../skills/builtin");
  }

  // Production mode - skills/ is next to the bundled letta.js
  return join(thisDir, "skills");
}

/**
 * Source of a skill (for display and override resolution)
 */
export type SkillSource = "bundled" | "global" | "agent" | "project";

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

export interface SkillDiscoveryOptions {
  skipBundled?: boolean;
  sources?: SkillSource[];
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
 * Get the agent-scoped skills directory for a specific agent
 * @param agentId - The Letta agent ID (e.g., "agent-abc123")
 * @returns Path like ~/.letta/agents/agent-abc123/skills/
 */
export function getAgentSkillsDir(agentId: string): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".letta/agents",
    agentId,
    "skills",
  );
}

/**
 * Parse a bundled skill from its embedded content
 */
/**
 * Get bundled skills by discovering from the bundled skills directory
 */
export async function getBundledSkills(): Promise<Skill[]> {
  const bundledPath = getBundledSkillsPath();
  const result = await discoverSkillsFromDir(bundledPath, "bundled");
  return result.skills;
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
 * Discovers skills from all sources (bundled, global, agent, project)
 * Later sources override earlier ones with the same ID.
 *
 * Priority order (highest to lowest):
 * 1. Project skills (.skills/ in current directory)
 * 2. Agent skills (~/.letta/agents/{agent-id}/skills/)
 * 3. Global skills (~/.letta/skills/)
 * 4. Bundled skills (embedded in package)
 *
 * @param projectSkillsPath - The project skills directory (default: .skills in current directory)
 * @param agentId - Optional agent ID for agent-scoped skills
 * @returns A result containing discovered skills and any errors
 */
export async function discoverSkills(
  projectSkillsPath: string = join(process.cwd(), SKILLS_DIR),
  agentId?: string,
  options?: SkillDiscoveryOptions,
): Promise<SkillDiscoveryResult> {
  const allErrors: SkillDiscoveryError[] = [];
  const skillsById = new Map<string, Skill>();
  const sourceSet = new Set(options?.sources ?? ALL_SKILL_SOURCES);
  const includeSource = (source: SkillSource) => sourceSet.has(source);

  // 1. Start with bundled skills (lowest priority)
  if (includeSource("bundled") && !options?.skipBundled) {
    const bundledSkills = await getBundledSkills();
    for (const skill of bundledSkills) {
      skillsById.set(skill.id, skill);
    }
  }

  // 2. Add global skills (override bundled)
  if (includeSource("global")) {
    const globalResult = await discoverSkillsFromDir(
      GLOBAL_SKILLS_DIR,
      "global",
    );
    allErrors.push(...globalResult.errors);
    for (const skill of globalResult.skills) {
      skillsById.set(skill.id, skill);
    }
  }

  // 3. Add agent skills if agentId provided (override global)
  if (agentId && includeSource("agent")) {
    const agentSkillsDir = getAgentSkillsDir(agentId);
    const agentResult = await discoverSkillsFromDir(agentSkillsDir, "agent");
    allErrors.push(...agentResult.errors);
    for (const skill of agentResult.skills) {
      skillsById.set(skill.id, skill);
    }
  }

  // 4. Add project skills (override all - highest priority)
  if (includeSource("project")) {
    const projectResult = await discoverSkillsFromDir(
      projectSkillsPath,
      "project",
    );
    allErrors.push(...projectResult.errors);
    for (const skill of projectResult.skills) {
      skillsById.set(skill.id, skill);
    }
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
 * Format discovered skills as a system reminder for injection into conversation.
 * Returns empty string if no skills are available.
 *
 * Format: `- name (source): description` for each skill.
 */
export function formatSkillsAsSystemReminder(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = skills.map((s) => `- ${s.id} (${s.source}): ${s.description}`);

  return `<system-reminder>
The following skills are available for use with the Skill tool:

${lines.join("\n")}
</system-reminder>`;
}
