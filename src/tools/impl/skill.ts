import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCurrentAgentId, getSkillsDirectory } from "@/agent/context";
import { resolveScopedMemoryDir } from "@/agent/memory-filesystem";
import {
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  getBundledSkills,
  getFrontmatterBoolean,
  getFrontmatterStringList,
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
  args?: string;
  /** Injected by executeTool - the tool_call_id for this invocation */
  toolCallId?: string;
  /** Injected by executeTool in listener mode for scoped agent resolution. */
  parentScope?: { agentId: string; conversationId: string };
}

interface SkillResult {
  message: string;
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
 * Check if a skill directory has additional files beyond SKILL.md
 */
function hasAdditionalFiles(skillMdPath: string): boolean {
  try {
    const skillDir = dirname(skillMdPath);
    const entries = readdirSync(skillDir);
    return entries.some((e) => e.toUpperCase() !== "SKILL.MD");
  } catch {
    return false;
  }
}

/**
 * Read skill content from file or bundled source
 * Returns both content and the path to the SKILL.md file
 *
 * Search order (highest priority first):
 * 1. Project skills (.agents/skills/, then legacy .skills/ fallback)
 * 2. Agent memory skills (~/.letta/agents/{id}/memory/skills/)
 * 3. Agent memory skills fallback ($MEMORY_DIR/skills/)
 * 4. Global skills (~/.letta/skills/)
 * 5. Bundled skills
 */
export async function readSkillContent(
  skillId: string,
  skillsDir: string,
  agentId?: string,
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

  // 4. Try global skills directory
  const globalSkillPath = join(GLOBAL_SKILLS_DIR, skillId, "SKILL.md");
  try {
    const content = await readFile(globalSkillPath, "utf-8");
    return { content, path: globalSkillPath };
  } catch {
    // Not in global, continue
  }

  // 5. Try bundled skills (lowest priority)
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

function splitSkillArguments(args: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
  for (const match of args.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[0];
    parts.push(raw.replace(/\\(["'\\])/g, "$1"));
  }
  return parts;
}

function substituteSkillArguments(
  content: string,
  args: string | undefined,
  argumentNames: string[] | undefined,
): string {
  const rawArgs = args?.trim() ?? "";
  if (!rawArgs) {
    return content;
  }

  const argParts = splitSkillArguments(rawArgs);
  let result = content;
  let substituted = false;

  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index) => {
    substituted = true;
    return argParts[Number(index)] ?? "";
  });

  result = result.replace(/\$ARGUMENTS/g, () => {
    substituted = true;
    return rawArgs;
  });

  result = result.replace(/\$(\d+)\b/g, (_match, index) => {
    substituted = true;
    return argParts[Number(index)] ?? "";
  });

  for (const [index, name] of (argumentNames ?? []).entries()) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`\\$${escapedName}\\b`, "g");
    result = result.replace(namePattern, () => {
      substituted = true;
      return argParts[index] ?? "";
    });
  }

  if (!substituted) {
    result = `${result.trimEnd()}\n\nARGUMENTS: ${rawArgs}`;
  }

  return result;
}

export interface RenderSkillContentOptions {
  args?: string;
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
  const hasExtras = hasAdditionalFiles(skillPath);
  const argumentNames = getFrontmatterStringList(frontmatter, "arguments");
  const withSkillDir = skillContent
    .replace(/<SKILL_DIR>/g, skillDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  const withArguments = substituteSkillArguments(
    withSkillDir,
    options.args,
    argumentNames,
  );
  const dirHeader = hasExtras ? `# Skill Directory: ${skillDir}\n\n` : "";
  return `${dirHeader}${withArguments}`;
}

export async function loadRenderedSkillContent(
  skillName: string,
  options: RenderSkillContentOptions & {
    agentId?: string;
    skillsDir?: string;
  } = {},
): Promise<string> {
  const skillsDir = options.skillsDir ?? (await getResolvedSkillsDir());
  const { content: skillContent, path: skillPath } = await readSkillContent(
    skillName,
    skillsDir,
    options.agentId,
  );
  return renderSkillContent(skillName, skillContent, skillPath, options);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function wrapSkillContent(skillName: string, content: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(skillName)) {
    return `<${skillName}>\n${content}\n</${skillName}>`;
  }
  return `<skill name="${escapeXmlAttribute(skillName)}">\n${content}\n</skill>`;
}

export async function skill(args: SkillArgs): Promise<SkillResult> {
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
      agentId,
      skillsDir,
      args: args.args,
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
