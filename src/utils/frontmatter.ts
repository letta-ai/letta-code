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

function parseBlockScalar(
  lines: string[],
  style: "|" | ">",
  chomping: "" | "+" | "-",
): string {
  const contentIndent = lines.reduce<number | null>((minimum, line) => {
    if (!line.trim()) return minimum;
    const indentation = line.length - line.trimStart().length;
    return minimum === null ? indentation : Math.min(minimum, indentation);
  }, null);
  const deindented = lines.map((line) =>
    line.trim() && contentIndent !== null ? line.slice(contentIndent) : "",
  );

  let value: string;
  if (style === "|") {
    value = deindented.join("\n");
  } else {
    let pendingBreaks = 0;
    value = "";
    for (const line of deindented) {
      if (!line) {
        pendingBreaks += 1;
        continue;
      }
      if (value) {
        value += pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ";
      } else if (pendingBreaks > 0) {
        value += "\n".repeat(pendingBreaks);
      }
      value += line;
      pendingBreaks = 0;
    }
    value += "\n".repeat(pendingBreaks);
  }

  if (chomping === "+") return `${value}\n`;
  const withoutTrailingNewlines = value.replace(/\n+$/, "");
  return chomping === "-"
    ? withoutTrailingNewlines
    : `${withoutTrailingNewlines}\n`;
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const trimmedLine = line.trim();
    const indentation = line.length - line.trimStart().length;

    if (indentation > 0) {
      // Preserve the existing top-level string-array support without flattening
      // nested YAML objects into the frontmatter record.
      if (indentation <= 2 && trimmedLine.startsWith("-") && currentKey) {
        const value = trimmedLine.slice(1).trim();
        currentArray.push(value);
      }
      continue;
    }

    savePendingKey();

    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      const blockScalar = value.match(/^([|>])([+-]?)$/);
      if (blockScalar?.[1]) {
        const blockLines: string[] = [];
        let blockLineIndex = lineIndex + 1;
        for (; blockLineIndex < lines.length; blockLineIndex += 1) {
          const blockLine = lines[blockLineIndex] ?? "";
          if (blockLine.trim() && blockLine === blockLine.trimStart()) break;
          blockLines.push(blockLine);
        }
        frontmatter[key] = parseBlockScalar(
          blockLines,
          blockScalar[1] as "|" | ">",
          (blockScalar[2] ?? "") as "" | "+" | "-",
        );
        lineIndex = blockLineIndex - 1;
        continue;
      }

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
