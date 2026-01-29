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
 * Skills block character limit.
 * If formatted skills exceed this, fall back to compact tree format.
 */
const SKILLS_BLOCK_CHAR_LIMIT = 20000;

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
): Promise<SkillDiscoveryResult> {
  const allErrors: SkillDiscoveryError[] = [];
  const skillsById = new Map<string, Skill>();

  // 1. Start with bundled skills (lowest priority)
  const bundledSkills = await getBundledSkills();
  for (const skill of bundledSkills) {
    skillsById.set(skill.id, skill);
  }

  // 2. Add global skills (override bundled)
  const globalResult = await discoverSkillsFromDir(GLOBAL_SKILLS_DIR, "global");
  allErrors.push(...globalResult.errors);
  for (const skill of globalResult.skills) {
    skillsById.set(skill.id, skill);
  }

  // 3. Add agent skills if agentId provided (override global)
  if (agentId) {
    const agentSkillsDir = getAgentSkillsDir(agentId);
    const agentResult = await discoverSkillsFromDir(agentSkillsDir, "agent");
    allErrors.push(...agentResult.errors);
    for (const skill of agentResult.skills) {
      skillsById.set(skill.id, skill);
    }
  }

  // 4. Add project skills (override all - highest priority)
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
 * @param agentId - Optional agent ID for agent-scoped skills display
 * @returns Full metadata string representation
 */
function formatSkillsWithMetadata(
  skills: Skill[],
  skillsDirectory: string,
  agentId?: string,
): string {
  let output = `Skills Directory: ${skillsDirectory}\n`;
  output += `Global Skills Directory: ${GLOBAL_SKILLS_DIR}\n`;
  if (agentId) {
    output += `Agent Skills Directory: ${getAgentSkillsDir(agentId)}\n`;
  }
  output += "\n";

  if (skills.length === 0) {
    return `${output}[NO SKILLS AVAILABLE]`;
  }

  output += "Available Skills:\n";
  output +=
    "(source: bundled = built-in to Letta Code, global = shared across all agents on this machine (~/.letta/skills/), agent = skills specific to you (~/.letta/agents/{id}/skills/), project = current project only (.skills/))\n\n";

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
 * @param agentId - Optional agent ID for agent-scoped skills display
 * @returns Formatted string representation of skills
 */
export function formatSkillsForMemory(
  skills: Skill[],
  skillsDirectory: string,
  agentId?: string,
): string {
  // Handle empty case
  if (skills.length === 0) {
    return `Skills Directory: ${skillsDirectory}\n\n[NO SKILLS AVAILABLE]`;
  }

  // Try full metadata format first
  const fullFormat = formatSkillsWithMetadata(skills, skillsDirectory, agentId);

  // If within limit, use full format
  if (fullFormat.length <= SKILLS_BLOCK_CHAR_LIMIT) {
    return fullFormat;
  }

  // Otherwise fall back to compact tree format
  return formatSkillsAsTree(skills, skillsDirectory);
}

// ============================================================================
// Skills Sync with Hash-Based Caching (Phase 2.5 - LET-7101)
// ============================================================================

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Get the project-local skills hash file path.
 * Uses .letta/skills-hash.json in the current working directory
 * because the skills block content depends on the project's .skills/ folder.
 */
function getSkillsHashFilePath(): string {
  return join(process.cwd(), ".letta", "skills-hash.json");
}

interface SkillsHashCache {
  hash: string;
  timestamp: string;
}

/**
 * Compute a hash of the formatted skills content
 */
function computeSkillsHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Get the cached skills hash (if any)
 */
async function getCachedSkillsHash(): Promise<string | null> {
  try {
    const hashFile = getSkillsHashFilePath();
    const data = await readFile(hashFile, "utf-8");
    const cache: SkillsHashCache = JSON.parse(data);
    return cache.hash;
  } catch {
    return null;
  }
}

/**
 * Set the cached skills hash
 */
async function setCachedSkillsHash(hash: string): Promise<void> {
  try {
    const hashFile = getSkillsHashFilePath();
    // Ensure project .letta directory exists
    const lettaDir = join(process.cwd(), ".letta");
    await mkdir(lettaDir, { recursive: true });

    const cache: SkillsHashCache = {
      hash,
      timestamp: new Date().toISOString(),
    };
    await writeFile(hashFile, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write failures - not critical
  }
}

/**
 * Sync skills to an agent's memory block.
 * Discovers skills from filesystem and updates the skills block.
 *
 * @param client - Letta client
 * @param agentId - Agent ID to update
 * @param skillsDirectory - Path to project skills directory
 * @param options - Optional settings
 * @returns Object indicating if sync occurred and discovered skills
 */
export async function syncSkillsToAgent(
  client: import("@letta-ai/letta-client").default,
  agentId: string,
  skillsDirectory: string,
  options?: { skipIfUnchanged?: boolean },
): Promise<{ synced: boolean; skills: Skill[] }> {
  // Discover skills from filesystem (including agent-scoped skills)
  const { skills, errors } = await discoverSkills(skillsDirectory, agentId);

  if (errors.length > 0) {
    for (const error of errors) {
      console.warn(`[skills] Discovery error: ${error.path}: ${error.message}`);
    }
  }

  // Format skills for memory block
  const formattedSkills = formatSkillsForMemory(
    skills,
    skillsDirectory,
    agentId,
  );

  // Check if we can skip the update
  if (options?.skipIfUnchanged) {
    const newHash = computeSkillsHash(formattedSkills);
    const cachedHash = await getCachedSkillsHash();

    if (newHash === cachedHash) {
      return { synced: false, skills };
    }

    // Update the block and cache the new hash
    await client.agents.blocks.update("skills", {
      agent_id: agentId,
      value: formattedSkills,
    });
    await setCachedSkillsHash(newHash);

    return { synced: true, skills };
  }

  // No skip option - always update
  await client.agents.blocks.update("skills", {
    agent_id: agentId,
    value: formattedSkills,
  });

  // Update hash cache for future runs
  const newHash = computeSkillsHash(formattedSkills);
  await setCachedSkillsHash(newHash);

  return { synced: true, skills };
}
