/**
 * Shared frontmatter parsing utility for Markdown files with YAML frontmatter
 */

/**
 * Parse frontmatter and content from a markdown file
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match || !match[1] || !match[2]) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, string | string[]> = {};

  // Parse YAML-like frontmatter (simple key: value pairs and arrays)
  const lines = frontmatterText.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of lines) {
    // Check if this is an array item
    if (line.trim().startsWith("-") && currentKey) {
      const value = line.trim().slice(1).trim();
      currentArray.push(value);
      continue;
    }

    // If we were building an array, save it
    if (currentKey && currentArray.length > 0) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = [];
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      currentKey = key;

      if (value) {
        // Simple key: value pair
        frontmatter[key] = value;
        currentKey = null;
      } else {
        // Might be starting an array
        currentArray = [];
      }
    }
  }

  // Save any remaining array
  if (currentKey && currentArray.length > 0) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Generate frontmatter string from an object
 */
export function generateFrontmatter(
  data: Record<string, string | string[] | undefined>,
): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length > 0) {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}
