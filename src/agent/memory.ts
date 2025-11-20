/**
 * Agent memory block management
 * Loads memory blocks from .mdx files in src/agent/prompts
 */

import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { MEMORY_PROMPTS } from "./promptAssets";
import { settingsManager } from "../settings-manager";

/**
 * Parse frontmatter and content from an .mdx file
 */
function parseMdxFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match || !match[1] || !match[2]) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, string> = {};

  // Parse YAML-like frontmatter (simple key: value pairs)
  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Load memory blocks from .mdx files in src/agent/prompts
 */
async function loadMemoryBlocksFromMdx(): Promise<CreateBlock[]> {
  const memoryBlocks: CreateBlock[] = [];

  const mdxFiles = ["persona.mdx", "human.mdx", "project.mdx", "skills.mdx"];
  // const mdxFiles = ["persona.mdx", "human.mdx", "style.mdx"];
  // const mdxFiles = ["persona_kawaii.mdx", "human.mdx", "style.mdx"];

  // Settings are initialized during CLI startup; this will throw if not initialized.
  const settings = settingsManager.getSettings();
  const useEmptyPersona = settings.useEmptyPersona === true;

  for (const filename of mdxFiles) {
    try {
      const content = MEMORY_PROMPTS[filename];
      if (!content) {
        console.warn(`Missing embedded prompt file: ${filename}`);
        continue;
      }
      const { frontmatter, body } = parseMdxFrontmatter(content);

      const label = frontmatter.label || filename.replace(".mdx", "");

      const block: CreateBlock = {
        label,
        value:
          useEmptyPersona && filename === "persona.mdx"
            ? ""
            : body,
      };

      if (frontmatter.description) {
        block.description = frontmatter.description;
      }

      memoryBlocks.push(block);
    } catch (error) {
      console.error(`Error loading ${filename}:`, error);
    }
  }

  return memoryBlocks;
}

// Cache for loaded memory blocks
let cachedMemoryBlocks: CreateBlock[] | null = null;

/**
 * Get default starter memory blocks for new agents
 */
export async function getDefaultMemoryBlocks(): Promise<CreateBlock[]> {
  if (!cachedMemoryBlocks) {
    cachedMemoryBlocks = await loadMemoryBlocksFromMdx();

    // Add a dedicated per-agent plan block so Codex-style tools like update_plan
    // have a concrete memory target from the very first run.
    //
    // We intentionally do NOT persist this block's ID in global/local shared
    // block mappings, so each new agent gets its own plan block instead of
    // reusing another agent's plan.
    const hasPlanBlock = cachedMemoryBlocks.some(
      (block) => block.label === "plan",
    );

    if (!hasPlanBlock) {
      cachedMemoryBlocks.push({
        label: "plan",
        value: "",
        description: "Structured task plan recorded and updated via update_plan",
      });
    }
  }
  return cachedMemoryBlocks;
}
