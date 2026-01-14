/**
 * Agent memory block management
 * Loads memory blocks from .mdx files in src/agent/prompts
 */

import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { MEMORY_PROMPTS } from "./promptAssets";

/**
 * Block labels that are stored globally (shared across all projects).
 */
export const GLOBAL_BLOCK_LABELS = ["persona", "human"] as const;

/**
 * Block labels that are stored per-project (local to the current directory).
 */
export const PROJECT_BLOCK_LABELS = [
  "project",
  "skills",
  "loaded_skills",
] as const;

/**
 * All available memory block labels (derived from global + project blocks)
 */
export const MEMORY_BLOCK_LABELS = [
  ...GLOBAL_BLOCK_LABELS,
  ...PROJECT_BLOCK_LABELS,
] as const;

/**
 * Type for memory block labels
 */
export type MemoryBlockLabel = (typeof MEMORY_BLOCK_LABELS)[number];

/**
 * Block labels that should be read-only (agent cannot modify via memory tools).
 * These blocks are managed by specific tools (e.g., Skill tool for skills/loaded_skills).
 */
export const READ_ONLY_BLOCK_LABELS = ["skills", "loaded_skills"] as const;

/**
 * Check if a block label is a project-level block
 */
export function isProjectBlock(label: string): boolean {
  return (PROJECT_BLOCK_LABELS as readonly string[]).includes(label);
}

/**
 * Parse frontmatter and content from an .mdx file
 */
export function parseMdxFrontmatter(content: string): {
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

  const mdxFiles = MEMORY_BLOCK_LABELS.map((label) => `${label}.mdx`);

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
        value: body,
      };

      if (frontmatter.description) {
        block.description = frontmatter.description;
      }

      if (frontmatter.limit) {
        const limit = parseInt(frontmatter.limit, 10);
        if (!Number.isNaN(limit) && limit > 0) {
          block.limit = limit;
        }
      }

      // Set read-only for skills blocks (managed by Skill tool, not memory tools)
      if ((READ_ONLY_BLOCK_LABELS as readonly string[]).includes(label)) {
        block.read_only = true;
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
