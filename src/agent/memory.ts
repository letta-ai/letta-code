import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { READ_ONLY_BLOCK_LABELS } from "./memory-constants";
import { MEMORY_PROMPTS } from "./prompt-assets";

export const MEMORY_BLOCK_LABELS = ["persona", "human"] as const;

export { READ_ONLY_BLOCK_LABELS };

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

let cachedMemoryBlocks: CreateBlock[] | null = null;

export async function getDefaultMemoryBlocks(): Promise<CreateBlock[]> {
  if (!cachedMemoryBlocks) {
    cachedMemoryBlocks = await loadMemoryBlocksFromMdx();
  }
  return cachedMemoryBlocks;
}
