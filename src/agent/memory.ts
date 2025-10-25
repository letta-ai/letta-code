/**
 * Agent memory block management
 * Loads memory blocks from .mdx files in src/agent/prompts
 */

import type { Letta } from "@letta-ai/letta-client";
import { MEMORY_PROMPTS } from "./promptAssets";

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
async function loadMemoryBlocksFromMdx(): Promise<Letta.CreateBlock[]> {
  const memoryBlocks: Letta.CreateBlock[] = [];

  const mdxFiles = ["persona.mdx", "human.mdx", "project.mdx"];
  // const mdxFiles = ["persona.mdx", "human.mdx", "style.mdx"];
  // const mdxFiles = ["persona_kawaii.mdx", "human.mdx", "style.mdx"];

  for (const filename of mdxFiles) {
    try {
      const content = MEMORY_PROMPTS[filename];
      if (!content) {
        console.warn(`Missing embedded prompt file: ${filename}`);
        continue;
      }
      const { frontmatter, body } = parseMdxFrontmatter(content);

      const block: Letta.CreateBlock = {
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
let cachedMemoryBlocks: Letta.CreateBlock[] | null = null;

/**
 * Get default starter memory blocks for new agents
 */
export async function getDefaultMemoryBlocks(): Promise<Letta.CreateBlock[]> {
  if (!cachedMemoryBlocks) {
    cachedMemoryBlocks = await loadMemoryBlocksFromMdx();
  }
  return cachedMemoryBlocks;
}
