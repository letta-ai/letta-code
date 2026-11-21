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
import { resolveGlobalStateDir } from "@/utils/settings-path";
import { isLocalAgentId } from "./agent-id";
import { ALL_SKILL_SOURCES, type SkillSource } from "./skill-sources";

function getBundledSkillsPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));

  if (thisDir.includes("src/agent") || thisDir.includes("src\\agent")) {
    return join(thisDir, "../skills/builtin");
  }

  return join(thisDir, "skills");
}

export type { SkillSource } from "./skill-sources";

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Optional additional trigger guidance from `when_to_use` frontmatter */
  whenToUse?: string;
  /** Hint shown in slash-command autocomplete */
  argumentHint?: string;
  /** If true, hide from model auto-invocation / Skill tool listings */
  disableModelInvocation?: boolean;
  /** If false, hide from slash-command user invocation */
  userInvocable?: boolean;
  category?: string;
  tags?: string[];
  /** Path to the skill file (empty for bundled skills) */
  path: string;
  source: SkillSource;
  /** Raw content of the skill (for bundled skills) */
  content?: string;
}

export interface SkillDiscoveryResult {
  skills: Skill[];
  errors: SkillDiscoveryError[];
}

export interface SkillDiscoveryOptions {
  skipBundled?: boolean;
  sources?: SkillSource[];
}

export interface SkillDiscoveryError {
  path: string;
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

const LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS = new Set([
  "image-generation",
  "managing-agent-webhooks",
  "managing-shared-memory",
  "music-generation",
  "speech-generation",
  "video-generation",
  "working-across-computers",
]);

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

export const PROJECT_SKILLS_DIR = join(".agents", "skills");

/**
 * Legacy directory name where project skills were stored.
 */
export const SKILLS_DIR = ".skills";

export function getGlobalSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    resolveGlobalStateDir(env, env.HOME || env.USERPROFILE || "~"),
    "skills",
  );
}

/**
 * Get the agent-scoped skills directory for a specific agent.
 * Primary path is <product-config>/agents/{id}/memory/skills/ (memfs).
 */
export function getAgentSkillsDir(agentId: string): string {
  return join(resolveGlobalStateDir(), "agents", agentId, "memory/skills");
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

async function discoverSkillsFromDir(
  skillsPath: string,
  source: SkillSource,
): Promise<SkillDiscoveryResult> {
  const errors: SkillDiscoveryError[] = [];

  if (!existsSync(skillsPath)) {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];

  try {
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

  if (includeSource("bundled") && !options?.skipBundled) {
    const bundledSkills = await getBundledSkills();
    for (const skill of bundledSkills) {
      skillsById.set(skill.id, skill);
    }
  }

  if (includeSource("global")) {
    const globalResult = await discoverSkillsFromDir(
      getGlobalSkillsDir(),
      "global",
    );
    allErrors.push(...globalResult.errors);
    for (const skill of globalResult.skills) {
      skillsById.set(skill.id, skill);
    }
  }

  if (agentId && includeSource("agent")) {
    const agentSkillsDir = getAgentSkillsDir(agentId);
    const agentResult = await discoverSkillsFromDir(agentSkillsDir, "agent");
    allErrors.push(...agentResult.errors);
    for (const skill of agentResult.skills) {
      skillsById.set(skill.id, skill);
    }
  }

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
    skills: Array.from(skillsById.values())
      .filter((skill) => isSkillAvailableForAgent(skill, agentId))
      .sort(compareSkills),
    errors: allErrors,
  };
}

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
          await findSkillFiles(
            fullPath,
            rootPath,
            skills,
            errors,
            source,
            visitedRealPaths,
          );
        } else if (isFile && entry.name.toUpperCase() === "SKILL.MD") {
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

async function parseSkillFile(
  filePath: string,
  rootPath: string,
  source: SkillSource,
): Promise<Skill | null> {
  const content = await readFile(filePath, "utf-8");

  const { frontmatter, body } = parseFrontmatter(content);

  const normalizedRoot = rootPath.endsWith("/")
    ? rootPath.slice(0, -1)
    : rootPath;
  const relativePath = filePath.slice(normalizedRoot.length + 1); // +1 to remove leading slash
  const dirPath = relativePath.slice(0, -"/SKILL.MD".length);
  const defaultId = dirPath || "root";

  const frontmatterName = getFrontmatterString(frontmatter, "name");
  const id =
    getFrontmatterString(frontmatter, "id") || frontmatterName || defaultId;

  const name =
    frontmatterName ||
    (typeof frontmatter.title === "string" ? frontmatter.title : null) ||
    (id.split("/").pop() ?? "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());

  let description = getFrontmatterString(frontmatter, "description") ?? null;
  if (!description) {
    const firstParagraph = body.trim().split("\n\n")[0];
    description = firstParagraph || "No description available";
  }
  description = description.trim();

  const whenToUse = getFrontmatterString(frontmatter, "when_to_use")?.trim();
  const modelDescription = whenToUse
    ? `${description}\n\nWhen to use: ${whenToUse}`
    : description;

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
