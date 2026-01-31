import { createHash } from "node:crypto";

/**
 * Parse MDX-style frontmatter from content.
 * This is a copy of parseMdxFrontmatter from src/agent/memory.ts.
 * The test ensures this stays in sync with the original.
 */
export function parseFrontmatter(content: string): {
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

export function hashFileBody(content: string): string {
  const { body } = parseFrontmatter(content);
  return createHash("sha256").update(body).digest("hex");
}
