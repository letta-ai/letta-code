import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getClient } from "../../agent/client";
import {
  getConversationId,
  getCurrentAgentId,
  getSkillsDirectory,
  setHasLoadedSkills,
} from "../../agent/context";
import {
  discoverSkills,
  formatSkillsForMemory,
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  getBundledSkills,
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

// Cache for isolated block IDs: Map<label, blockId>
// This avoids repeated API calls within a session
let isolatedBlockCache: Map<string, string> | null = null;
let cachedConversationId: string | null = null;

/**
 * Clear the cache (called when conversation changes or on errors)
 */
function clearIsolatedBlockCache(): void {
  isolatedBlockCache = null;
  cachedConversationId = null;
}

/**
 * Get the block ID for an isolated block label in the current conversation context.
 * Uses caching to avoid repeated API calls.
 * If in a conversation with isolated blocks, returns the isolated block ID.
 * Otherwise returns null (use agent-level block).
 *
 * SAFETY: Any error returns null (falls back to agent-level block).
 * Caching never causes errors - only helps performance.
 */
async function getIsolatedBlockId(
  client: Awaited<ReturnType<typeof getClient>>,
  label: string,
): Promise<string | null> {
  const conversationId = getConversationId();

  // "default" conversation doesn't have isolated blocks
  if (!conversationId || conversationId === "default") {
    return null;
  }

  try {
    // Check if conversation changed - invalidate cache
    if (cachedConversationId !== conversationId) {
      clearIsolatedBlockCache();
      cachedConversationId = conversationId;
    }

    // Check cache first
    if (isolatedBlockCache?.has(label)) {
      return isolatedBlockCache.get(label) ?? null;
    }

    // Cache miss - fetch from API
    const conversation = await client.conversations.retrieve(conversationId);
    const isolatedBlockIds = conversation.isolated_block_ids || [];

    if (isolatedBlockIds.length === 0) {
      // No isolated blocks - cache this fact as empty map
      isolatedBlockCache = new Map();
      return null;
    }

    // Build cache: fetch all isolated blocks and map label -> blockId
    if (!isolatedBlockCache) {
      isolatedBlockCache = new Map();
    }

    for (const blockId of isolatedBlockIds) {
      try {
        const block = await client.blocks.retrieve(blockId);
        if (block.label) {
          isolatedBlockCache.set(block.label, blockId);
        }
      } catch {
        // Individual block fetch failed - skip it, don't fail the whole operation
      }
    }

    return isolatedBlockCache.get(label) ?? null;
  } catch {
    // If anything fails, fall back to agent-level block (safe default)
    // Don't cache the error - next call will try again
    return null;
  }
}

/**
 * Update a block by label, using isolated block if in conversation context.
 *
 * SAFETY: If updating isolated block fails, clears cache and falls back to
 * agent-level block. Errors from agent-level update are propagated (that's
 * the existing behavior).
 */
async function updateBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  agentId: string,
  label: string,
  value: string,
): Promise<void> {
  const isolatedBlockId = await getIsolatedBlockId(client, label);

  if (isolatedBlockId) {
    try {
      // Update the conversation's isolated block directly
      await client.blocks.update(isolatedBlockId, { value });
      return;
    } catch {
      // If isolated block update fails (e.g., block was deleted),
      // clear cache and fall back to agent-level block
      clearIsolatedBlockCache();
      // Fall through to agent-level update
    }
  }

  // Fall back to agent-level block
  await client.agents.blocks.update(label, {
    agent_id: agentId,
    value,
  });
}

/**
 * Retrieve a block by label, using isolated block if in conversation context.
 *
 * SAFETY: If retrieving isolated block fails, clears cache and falls back to
 * agent-level block.
 */
async function retrieveBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  agentId: string,
  label: string,
): Promise<Awaited<ReturnType<typeof client.blocks.retrieve>>> {
  const isolatedBlockId = await getIsolatedBlockId(client, label);

  if (isolatedBlockId) {
    try {
      return await client.blocks.retrieve(isolatedBlockId);
    } catch {
      // If isolated block retrieval fails, clear cache and fall back
      clearIsolatedBlockCache();
      // Fall through to agent-level retrieval
    }
  }

  // Fall back to agent-level block
  return await client.agents.blocks.retrieve(label, { agent_id: agentId });
}

function coreMemoryBlockEditedMessage(label: string): string {
  return (
    `The core memory block with label \`${label}\` has been successfully edited. ` +
    "Your system prompt has been recompiled with the updated memory contents and is now active in your context. " +
    "Review the changes and make sure they are as expected (correct indentation, " +
    "no duplicate lines, etc). Edit the memory block again if necessary."
  );
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
 * 1. Project skills (.skills/)
 * 2. Agent skills (~/.letta/agents/{id}/skills/)
 * 3. Global skills (~/.letta/skills/)
 * 4. Bundled skills
 */
async function readSkillContent(
  skillId: string,
  skillsDir: string,
  agentId?: string,
): Promise<{ content: string; path: string }> {
  // 1. Check bundled skills first (they have a path now)
  const bundledSkills = await getBundledSkills();
  const bundledSkill = bundledSkills.find((s) => s.id === skillId);
  if (bundledSkill?.path) {
    try {
      const content = await readFile(bundledSkill.path, "utf-8");
      return { content, path: bundledSkill.path };
    } catch {
      // Bundled skill path not found, continue to other sources
    }
  }

  // 2. Try global skills directory
  const globalSkillPath = join(GLOBAL_SKILLS_DIR, skillId, "SKILL.md");
  try {
    const content = await readFile(globalSkillPath, "utf-8");
    return { content, path: globalSkillPath };
  } catch {
    // Not in global, continue
  }

  // 3. Try agent skills directory (if agentId provided)
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

  // 4. Try project skills directory
  const projectSkillPath = join(skillsDir, skillId, "SKILL.md");
  try {
    const content = await readFile(projectSkillPath, "utf-8");
    return { content, path: projectSkillPath };
  } catch {
    // Fallback: check for bundled skills in a repo-level skills directory (legacy)
    try {
      const bundledSkillsDir = join(process.cwd(), "skills", "skills");
      const bundledSkillPath = join(bundledSkillsDir, skillId, "SKILL.md");
      const content = await readFile(bundledSkillPath, "utf-8");
      return { content, path: bundledSkillPath };
    } catch {
      // If all fallbacks fail, throw a helpful error message (LET-7101)
      // Suggest refresh in case skills sync is still running in background
      throw new Error(
        `Skill "${skillId}" not found. If you recently added this skill, try Skill({ command: "refresh" }) to re-scan the skills directory.`,
      );
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

      // Discover skills from directory (including agent-scoped skills)
      const { skills, errors } = await discoverSkills(skillsDir, agentId);

      // Log any errors
      if (errors.length > 0) {
        for (const error of errors) {
          console.warn(
            `Skill discovery error: ${error.path}: ${error.message}`,
          );
        }
      }

      // Format and update the skills block
      const formattedSkills = formatSkillsForMemory(skills, skillsDir, agentId);
      await updateBlock(client, agentId, "skills", formattedSkills);

      const successMsg =
        coreMemoryBlockEditedMessage("skills") +
        ` Found ${skills.length} skill(s)` +
        (errors.length > 0
          ? ` with ${errors.length} error(s) during discovery.`
          : ".");

      return { message: successMsg };
    }

    // Retrieve the loaded_skills block for load/unload
    let loadedSkillsBlock: Awaited<
      ReturnType<typeof client.agents.blocks.retrieve>
    >;
    try {
      loadedSkillsBlock = await retrieveBlock(client, agentId, "loaded_skills");
    } catch (error) {
      throw new Error(
        `Error: loaded_skills block not found. This block is required for the Skill tool to work.\nAgent ID: ${agentId}\nError: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const skillsDir = await getResolvedSkillsDir(client, agentId);

    let currentValue = loadedSkillsBlock.value?.trim() || "";
    const loadedSkillIds = getLoadedSkillIds(currentValue);

    // skillIds is guaranteed to be non-empty for load/unload (validated above)
    const skillsToProcess = skillIds as string[];

    if (command === "load") {
      const loaded: string[] = [];
      const alreadyLoaded: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const skillId of skillsToProcess) {
        if (loadedSkillIds.includes(skillId)) {
          alreadyLoaded.push(skillId);
          continue;
        }

        try {
          const { content: skillContent, path: skillPath } =
            await readSkillContent(skillId, skillsDir, agentId);

          // Replace placeholder if this is the first skill (support old and new formats)
          if (
            currentValue === "No skills currently loaded." ||
            currentValue === "[CURRENTLY EMPTY]"
          ) {
            currentValue = "";
          }

          // Build skill header with optional path info
          const skillDir = dirname(skillPath);
          const hasExtras = hasAdditionalFiles(skillPath);
          const pathLine = hasExtras
            ? `# Skill Directory: ${skillDir}\n\n`
            : "";

          // Replace <SKILL_DIR> placeholder with actual path in skill content
          const processedContent = hasExtras
            ? skillContent.replace(/<SKILL_DIR>/g, skillDir)
            : skillContent;

          // Append new skill
          const separator = currentValue ? "\n\n---\n\n" : "";
          currentValue = `${currentValue}${separator}# Skill: ${skillId}\n${pathLine}${processedContent}`;
          loadedSkillIds.push(skillId);
          loaded.push(skillId);
        } catch (error) {
          failed.push({
            id: skillId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (loaded.length > 0) {
        await updateBlock(client, agentId, "loaded_skills", currentValue);

        // Update the cached flag
        setHasLoadedSkills(true);
      }

      const messages: string[] = [];
      if (loaded.length > 0) {
        messages.push(coreMemoryBlockEditedMessage("loaded_skills"));
      }

      if (loaded.length > 0) {
        messages.push(
          `The following skill(s) have been successfully loaded into your \`loaded_skills\` memory block: ${loaded
            .map((id) => `\`${id}\``)
            .join(", ")}.`,
        );
      } else {
        messages.push("No new skills were loaded.");
      }

      if (alreadyLoaded.length > 0) {
        messages.push(
          `These skill(s) were already loaded: ${alreadyLoaded
            .map((id) => `\`${id}\``)
            .join(", ")}.`,
        );
      }

      if (failed.length > 0) {
        messages.push(
          `Failed to load the following skill(s): ${failed
            .map(({ id, error }) => `\`${id}\` (${error})`)
            .join(", ")}.`,
        );
      }

      messages.push(
        "Review your `loaded_skills` block for instructions and unload skills when you're done to free up context.",
      );

      return { message: messages.join(" ") };
    }

    // Unload skills
    const unloaded: string[] = [];
    const notLoaded: string[] = [];

    const skillBoundaries = parseLoadedSkills(currentValue);

    for (const skillId of skillsToProcess) {
      if (!loadedSkillIds.includes(skillId) || !skillBoundaries.has(skillId)) {
        notLoaded.push(skillId);
        continue;
      }
      unloaded.push(skillId);
    }

    // Sort skills to unload by their position (descending) so we can remove from end first
    const sortedSkillsToUnload = unloaded.sort((a, b) => {
      const boundaryA = skillBoundaries.get(a);
      const boundaryB = skillBoundaries.get(b);
      return (boundaryB?.start || 0) - (boundaryA?.start || 0);
    });

    // Remove skills from content (in reverse order to maintain indices)
    for (const skillId of sortedSkillsToUnload) {
      const boundary = skillBoundaries.get(skillId);
      if (!boundary) continue;

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

    // Clean up the value
    currentValue = currentValue.trim();
    if (currentValue === "") {
      currentValue = "No skills currently loaded.";
    }

    // Update the block
    await updateBlock(client, agentId, "loaded_skills", currentValue);

    // Update the cached flag
    const remainingSkills = getLoadedSkillIds(currentValue);
    setHasLoadedSkills(remainingSkills.length > 0);

    const messages: string[] = [coreMemoryBlockEditedMessage("loaded_skills")];
    if (unloaded.length > 0) {
      messages.push(
        `The following skill(s) have been successfully unloaded from your \`loaded_skills\` memory block: ${unloaded
          .map((id) => `\`${id}\``)
          .join(", ")}.`,
      );
    } else {
      messages.push("No skills were unloaded.");
    }

    if (notLoaded.length > 0) {
      messages.push(
        `These skill(s) were not loaded: ${notLoaded
          .map((id) => `\`${id}\``)
          .join(", ")}.`,
      );
    }

    messages.push("Your `loaded_skills` block has been updated.");

    return { message: messages.join(" ") };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to ${command} skill(s): ${String(error)}`);
  }
}

/**
 * Pre-load skills and return formatted content for the loaded_skills block.
 * This is used by subagent manager to pre-populate skills before the agent starts.
 */
export async function preloadSkillsContent(
  skillIds: string[],
  skillsDir: string,
  agentId?: string,
): Promise<string> {
  if (skillIds.length === 0) {
    return "No skills currently loaded.";
  }

  let content = "";

  for (const skillId of skillIds) {
    try {
      const { content: skillContent, path: skillPath } = await readSkillContent(
        skillId,
        skillsDir,
        agentId,
      );

      const skillDir = dirname(skillPath);
      const hasExtras = hasAdditionalFiles(skillPath);
      const pathLine = hasExtras ? `# Skill Directory: ${skillDir}\n\n` : "";

      // Replace <SKILL_DIR> placeholder with actual path
      const processedContent = hasExtras
        ? skillContent.replace(/<SKILL_DIR>/g, skillDir)
        : skillContent;

      const separator = content ? "\n\n---\n\n" : "";
      content = `${content}${separator}# Skill: ${skillId}\n${pathLine}${processedContent}`;
    } catch (error) {
      // Skip skills that can't be loaded
      console.error(
        `Warning: Could not pre-load skill "${skillId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return content || "No skills currently loaded.";
}
