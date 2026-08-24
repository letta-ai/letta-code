import { type Dirent, existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getCurrentAgentId,
  getSkillSources,
  getSkillsDirectory,
} from "@/agent/context";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import type { AttachedAgentRepository } from "@/agent/memory-git";
import {
  discoverSharedMemorySkills,
  resolveSharedMemorySkillsContext,
} from "@/agent/shared-memory-skills";
import {
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  getBundledSkills,
  getFrontmatterBoolean,
  isSkillAvailableForAgent,
  PROJECT_SKILLS_DIR,
  SKILLS_DIR,
} from "@/agent/skills";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { parseFrontmatter } from "@/utils/frontmatter";
import { queueSkillContent } from "./skill-content-registry";
import { validateRequiredParams } from "./validation.js";

interface SkillArgs {
  skill: string;
  /** Injected by executeTool - the tool_call_id for this invocation */
  toolCallId?: string;
  /** Injected by executeTool in listener mode for scoped agent resolution. */
  parentScope?: { agentId: string; conversationId: string };
}

interface SkillResult {
  message: string;
}

export interface ReadSkillContentOptions {
  attachedRepositories?: readonly AttachedAgentRepository[];
}

function getMemorySkillsDirs(agentId?: string): string[] {
  const dirs = new Set<string>();

  const scopedMemoryDir = resolveScopedMemoryDir({ agentId });
  if (
    scopedMemoryDir &&
    scopedMemoryDir.trim().length > 0 &&
    existsSync(scopedMemoryDir)
  ) {
    dirs.add(join(scopedMemoryDir.trim(), "skills"));
  } else {
    const fallbackMemoryDir = (
      process.env.LETTA_MEMORY_DIR ||
      process.env.MEMORY_DIR ||
      ""
    ).trim();
    if (fallbackMemoryDir) {
      dirs.add(join(fallbackMemoryDir, "skills"));
    }
  }

  return Array.from(dirs);
}

/**
 * List bundled resources without eagerly reading their contents.
 */
const MAX_LISTED_SKILL_RESOURCES = 200;

interface SkillResources {
  paths: string[];
  truncated: boolean;
}

function listSkillResources(skillMdPath: string): SkillResources {
  const skillDir = dirname(skillMdPath);
  const paths: string[] = [];
  let truncated = false;

  function walk(directory: string, relativeDirectory: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (relativePath.toUpperCase() === "SKILL.MD") {
        continue;
      }
      if (paths.length >= MAX_LISTED_SKILL_RESOURCES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relativePath);
        if (truncated) {
          return;
        }
      } else if (entry.isFile()) {
        paths.push(relativePath);
      }
    }
  }

  walk(skillDir, "");
  return { paths, truncated };
}

/**
 * Read skill content from file or bundled source
 * Returns both content and the path to the SKILL.md file
 *
 * Search order (highest priority first):
 * 1. Project skills (.agents/skills/, then legacy .skills/ fallback)
 * 2. Agent memory skills (~/.letta/agents/{id}/memory/skills/)
 * 3. Agent memory skills fallback ($MEMORY_DIR/skills/)
 * 4. Attached shared-memory skills
 * 5. Global skills (~/.letta/skills/)
 * 6. Bundled skills
 */
export async function readSkillContent(
  skillId: string,
  skillsDir: string,
  agentId?: string,
  options: ReadSkillContentOptions = {},
): Promise<{ content: string; path: string }> {
  // 1. Try project skills directory (highest priority)
  const projectSkillsDirs = new Set<string>([
    join(getCurrentWorkingDirectory(), PROJECT_SKILLS_DIR),
    skillsDir,
  ]);
  for (const projectSkillsDir of projectSkillsDirs) {
    const projectSkillPath = join(projectSkillsDir, skillId, "SKILL.md");
    try {
      const content = await readFile(projectSkillPath, "utf-8");
      return { content, path: projectSkillPath };
    } catch {
      // Not in this project skills directory, continue
    }
  }

  // 2. Try agent memory skills directory (if agentId provided)
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

  // 3. Try agent memory skills fallback directories
  for (const memorySkillsDir of getMemorySkillsDirs(agentId)) {
    const memorySkillPath = join(memorySkillsDir, skillId, "SKILL.md");
    try {
      const content = await readFile(memorySkillPath, "utf-8");
      return { content, path: memorySkillPath };
    } catch {
      // Not in this memory skills dir, continue
    }
  }

  // 4. Try attached shared-memory repositories
  const sharedMemoryContext = await resolveSharedMemorySkillsContext({
    agentId,
    skillSources: getSkillSources(),
    attachedRepositories: options.attachedRepositories,
  });
  const sharedMemoryDiscovery = await discoverSharedMemorySkills(
    sharedMemoryContext.skillsDirs,
  );
  const sharedSkill = sharedMemoryDiscovery.skills.find(
    (candidate) => candidate.id === skillId,
  );
  if (sharedSkill) {
    try {
      const content = await readFile(sharedSkill.path, "utf-8");
      return { content, path: sharedSkill.path };
    } catch {
      // Shared skill disappeared after discovery, continue
    }
  }

  // 5. Try global skills directory
  const globalSkillPath = join(GLOBAL_SKILLS_DIR, skillId, "SKILL.md");
  try {
    const content = await readFile(globalSkillPath, "utf-8");
    return { content, path: globalSkillPath };
  } catch {
    // Not in global, continue
  }

  // 6. Try bundled skills (lowest priority)
  const bundledSkills = await getBundledSkills();
  const bundledSkill = bundledSkills.find((s) => s.id === skillId);
  if (bundledSkill?.path && isSkillAvailableForAgent(bundledSkill, agentId)) {
    try {
      const content = await readFile(bundledSkill.path, "utf-8");
      return { content, path: bundledSkill.path };
    } catch {
      // Bundled skill path not found, continue to legacy fallback
    }
  }

  // Legacy fallback: check for bundled skills in a repo-level skills directory
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

/**
 * Get skills directory, trying multiple sources
 */
export async function getResolvedSkillsDir(): Promise<string> {
  const skillsDir = getSkillsDirectory();

  if (skillsDir) {
    return skillsDir;
  }

  // Fall back to the execution working directory when available.
  return join(getCurrentWorkingDirectory(), SKILLS_DIR);
}

function getResolvedAgentId(args: SkillArgs): string | undefined {
  if (args.parentScope?.agentId) {
    return args.parentScope.agentId;
  }

  try {
    return getCurrentAgentId();
  } catch {
    return undefined;
  }
}

export interface RenderSkillContentOptions {
  allowDisabledModelInvocation?: boolean;
}

export function renderSkillContent(
  skillName: string,
  skillContent: string,
  skillPath: string,
  options: RenderSkillContentOptions = {},
): string {
  const { frontmatter } = parseFrontmatter(skillContent);
  if (
    !options.allowDisabledModelInvocation &&
    getFrontmatterBoolean(frontmatter, "disable-model-invocation") === true
  ) {
    throw new Error(
      `Skill "${skillName}" is marked disable-model-invocation and can only be invoked directly by the user.`,
    );
  }

  const skillDir = dirname(skillPath);
  const withSkillDir = skillContent
    .replace(/<SKILL_DIR>/g, skillDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  const resources = listSkillResources(skillPath);
  const resourceLines = resources.paths.map(
    (resourcePath) => `  <file>${escapeXmlText(resourcePath)}</file>`,
  );
  if (resources.truncated) {
    resourceLines.push("  <truncated>true</truncated>");
  }
  const resourcesSection =
    resourceLines.length > 0
      ? `\n\n<skill_resources>\n${resourceLines.join("\n")}\n</skill_resources>`
      : "";

  return `${withSkillDir}\n\nSkill directory: ${skillDir}\nRelative paths in this skill are relative to the skill directory.${resourcesSection}`;
}

export async function loadRenderedSkillContent(
  skillName: string,
  options: RenderSkillContentOptions &
    ReadSkillContentOptions & {
      agentId?: string;
      skillsDir?: string;
    } = {},
): Promise<string> {
  const skillsDir = options.skillsDir ?? (await getResolvedSkillsDir());
  const { content: skillContent, path: skillPath } = await readSkillContent(
    skillName,
    skillsDir,
    options.agentId,
    options,
  );
  return renderSkillContent(skillName, skillContent, skillPath, options);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

export function wrapSkillContent(skillName: string, content: string): string {
  return `<skill_content name="${escapeXmlAttribute(skillName)}">\n${content}\n</skill_content>`;
}

export function wrapSkillPrompt(
  skillName: string,
  content: string,
  userRequest: string,
): string {
  const wrappedSkill = wrapSkillContent(skillName, content);
  return userRequest ? `${wrappedSkill}\n\n${userRequest}` : wrappedSkill;
}

export async function skill(
  args: SkillArgs,
  dependencies: ReadSkillContentOptions = {},
): Promise<SkillResult> {
  validateRequiredParams(args, ["skill"], "Skill");
  const { skill: skillName, toolCallId } = args;

  if (!skillName || typeof skillName !== "string") {
    throw new Error(
      'Invalid skill name. The "skill" parameter must be a non-empty string.',
    );
  }

  try {
    const agentId = getResolvedAgentId(args);
    const skillsDir = await getResolvedSkillsDir();

    const fullContent = await loadRenderedSkillContent(skillName, {
      ...dependencies,
      agentId,
      skillsDir,
    });

    // Queue the skill content for harness-level injection as a user message part
    // Wrap in <skill-name> XML tags so the agent can detect already-loaded skills
    if (toolCallId) {
      queueSkillContent(toolCallId, wrapSkillContent(skillName, fullContent));
    }

    return { message: `Launching skill: ${skillName}` };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to invoke skill "${skillName}": ${String(error)}`);
  }
}
