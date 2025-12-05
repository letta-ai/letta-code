/**
 * Agent memory block management
 * Loads memory blocks from .mdx files in src/agent/prompts
 */

import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { MEMORY_PROMPTS } from "./promptAssets";

/**
 * Block labels that are stored per-project (local to the current directory).
 * All other blocks are stored globally (shared across all projects).
 */
export const PROJECT_BLOCK_LABELS = [
  "project",
  "skills",
  "loaded_skills",
] as const;

/**
 * Check if a block label is a project-level block
 */
export function isProjectBlock(label: string): boolean {
  return (PROJECT_BLOCK_LABELS as readonly string[]).includes(label);
}

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

  const mdxFiles = [
    "persona_empty.mdx",
    "human.mdx",
    "project.mdx",
    "skills.mdx",
    "loaded_skills.mdx",
  ];

  for (const filename of mdxFiles) {
    try {
      const content = MEMORY_PROMPTS[filename];
      if (!content) {
        console.warn(`Missing embedded prompt file: ${filename}`);
        continue;
      }
      const { frontmatter, body } = parseMdxFrontmatter(content);

      const block: CreateBlock = {
        label: frontmatter.label || filename.replace(".mdx", ""),
        value: body,
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
  }
  return cachedMemoryBlocks;
}
