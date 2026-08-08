/**
 * Shared frontmatter parsing utility for Markdown files with YAML frontmatter
 */

/**
 * Parse a comma-separated string into an array of trimmed, non-empty strings
 */
export function parseCommaSeparatedList(str: string | undefined): string[] {
  if (!str || str.trim() === "") return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Get a string field from a frontmatter object, or undefined if not a string
 */
export function getStringField(
  obj: Record<string, string | string[]>,
  field: string,
): string | undefined {
  const val = obj[field];
  return typeof val === "string" ? val : undefined;
}

/**
 * Parse frontmatter and content from a markdown file
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  // Normalize common cross-platform file encodings so frontmatter parsing
  // works for user-authored files in .letta/agents/.
  // - Strip UTF-8 BOM when present
  // - Normalize CRLF (and lone CR) to LF
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/;
  const match = normalized.match(frontmatterRegex);

  if (!match || match[1] === undefined) {
    return { frontmatter: {}, body: normalized };
  }

  const frontmatterText = match[1];
  const body = match[2] ?? "";
  const frontmatter: Record<string, string | string[]> = {};

  // Parse YAML-like frontmatter (simple key: value pairs and arrays)
  const lines = frontmatterText.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  const savePendingKey = () => {
    if (!currentKey) return;
    frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
    currentKey = null;
    currentArray = [];
  };

  for (const line of lines) {
    // Check if this is an array item
    if (line.trim().startsWith("-") && currentKey) {
      const value = line.trim().slice(1).trim();
      currentArray.push(value);
      continue;
    }

    savePendingKey();

    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (value) {
        // Simple key: value pair
        frontmatter[key] = value;
      } else {
        // Might be starting an array. If no array items follow, this is an
        // explicit empty scalar field.
        currentKey = key;
        currentArray = [];
      }
    }
  }

  savePendingKey();

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
