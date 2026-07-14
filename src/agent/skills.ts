/**
 * Skills module - provides skill discovery and management functionality
 *
 * Skills are discovered from four sources (in order of priority):
 * 1. Project skills: .agents/skills/ in current directory, with .skills/ as a legacy fallback (highest priority - overrides)
 * 2. Agent skills: ~/.letta/agents/{agent-id}/memory/skills/ for agent-specific skills
 * 3. Global skills: ~/.letta/skills/ for user's personal skills
 * 4. Bundled skills: embedded in package (lowest priority - defaults)
 */

import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@/utils/frontmatter";
import { isLocalAgentId } from "./agent-id";
import { ALL_SKILL_SOURCES, type SkillSource } from "./skill-sources";

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

export type { SkillSource } from "./skill-sources";

/**
 * Represents a skill that can be used by the agent
 */
export interface Skill {
  /** Unique identifier for the skill */
  id: string;
  /** Human-readable name of the skill */
  name: string;
  /** Description of what the skill does and when to use it */
  description: string;
  /** Optional additional trigger guidance from `when_to_use` frontmatter */
  whenToUse?: string;
  /** Hint shown in slash-command autocomplete */
  argumentHint?: string;
  /** If true, hide from model auto-invocation / Skill tool listings */
  disableModelInvocation?: boolean;
  /** If false, hide from slash-command user invocation */
  userInvocable?: boolean;
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

export function compareSkills(a: Skill, b: Skill): number {
  return (
    a.id.localeCompare(b.id) ||
    a.source.localeCompare(b.source) ||
    a.path.localeCompare(b.path)
  );
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function getFrontmatterString(
  frontmatter: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" ? stripSurroundingQuotes(value) : undefined;
}

export function getFrontmatterStringList(
  frontmatter: Record<string, string | string[]>,
  key: string,
): string[] | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value.map(stripSurroundingQuotes).filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return stripSurroundingQuotes(value)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}

export function getFrontmatterBoolean(
  frontmatter: Record<string, string | string[]>,
  key: string,
): boolean | undefined {
  const value = getFrontmatterString(frontmatter, key)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function isModelInvocableSkill(skill: Skill): boolean {
  return skill.disableModelInvocation !== true;
}

export function isUserInvocableSkill(skill: Skill): boolean {
  return skill.userInvocable !== false;
}

const LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS = new Set(["image-generation"]);

export function isSkillAvailableForAgent(
  skill: Skill,
  agentId?: string,
): boolean {
  if (
    skill.source === "bundled" &&
    agentId &&
    isLocalAgentId(agentId) &&
    LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS.has(skill.id)
  ) {
    return false;
  }
  return true;
}

/**
 * Canonical directory where project skills are stored.
 */
export const PROJECT_SKILLS_DIR = join(".agents", "skills");

/**
 * Legacy directory name where project skills were stored.
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
 * Get the agent-scoped skills directory for a specific agent.
 * Primary path is ~/.letta/agents/{id}/memory/skills/ (memfs).
 */
export function getAgentSkillsDir(agentId: string): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".letta/agents",
    agentId,
    "memory/skills",
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
 * 1. Project skills (the provided project skills path; callers may scan .agents/skills before .skills)
 * 2. Agent skills (~/.letta/agents/{agent-id}/memory/skills/)
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
    skills: Array.from(skillsById.values()).sort(compareSkills),
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
  visitedRealPaths: Set<string> = new Set(),
): Promise<void> {
  try {
    const resolvedPath = await realpath(currentPath);
    if (visitedRealPaths.has(resolvedPath)) {
      return;
    }
    visitedRealPaths.add(resolvedPath);
  } catch (error) {
    errors.push({
      path: currentPath,
      message: `Failed to resolve directory path: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      try {
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();

        // Follow symlink targets so linked skills are discoverable.
        if (entry.isSymbolicLink()) {
          const entryStat = await stat(fullPath);
          isDirectory = entryStat.isDirectory();
          isFile = entryStat.isFile();
        }

        if (isDirectory) {
          // Recursively search subdirectories.
          await findSkillFiles(
            fullPath,
            rootPath,
            skills,
            errors,
            source,
            visitedRealPaths,
          );
        } else if (isFile && entry.name.toUpperCase() === "SKILL.MD") {
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
      } catch (error) {
        errors.push({
          path: fullPath,
          message: `Failed to inspect path: ${error instanceof Error ? error.message : String(error)}`,
        });
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
  let description = getFrontmatterString(frontmatter, "description") ?? null;
  if (!description) {
    // Extract first paragraph from content as description
    const firstParagraph = body.trim().split("\n\n")[0];
    description = firstParagraph || "No description available";
  }
  description = description.trim();

  const whenToUse = getFrontmatterString(frontmatter, "when_to_use")?.trim();
  const modelDescription = whenToUse
    ? `${description}\n\nWhen to use: ${whenToUse}`
    : description;

  // Extract tags (handle both string and array)
  const tags = getFrontmatterStringList(frontmatter, "tags");

  return {
    id,
    name,
    description: modelDescription,
    whenToUse,
    argumentHint: getFrontmatterString(frontmatter, "argument-hint"),
    disableModelInvocation:
      getFrontmatterBoolean(frontmatter, "disable-model-invocation") ?? false,
    userInvocable: getFrontmatterBoolean(frontmatter, "user-invocable") ?? true,
    category: getFrontmatterString(frontmatter, "category"),
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
  const lines = skills
    .filter(isModelInvocableSkill)
    .sort(compareSkills)
    .map((s) => `- ${s.id} (${s.source}): ${s.description}`);

  if (lines.length === 0) {
    return "";
  }

  return `<system-reminder>
The following skills are available for use with the Skill tool:

${lines.join("\n")}
</system-reminder>`;
}
