import { basename } from "node:path";
import {
  isMemoryIndexPath,
  type LocalMemoryFormat,
} from "@/agent/memory-format";

export interface MemoryMarkdownFrontmatter {
  name?: string;
  description?: string;
  read_only?: string;
}

export interface ParsedMemoryMarkdown {
  frontmatter: MemoryMarkdownFrontmatter;
  body: string;
}

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function parseScalarFrontmatter(frontmatterText: string) {
  const fields = new Map<string, string>();
  for (const line of frontmatterText.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return fields;
}

function parseV2FrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function defaultMemoryName(label: string): string {
  const fileName = basename(label.replace(/\\/g, "/"));
  const words = fileName.replace(/\.md$/i, "").split(/[-_]+/).filter(Boolean);
  const name = words
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
  return name || "Memory";
}

export function parseMemoryMarkdown(options: {
  content: string;
  relativePath: string;
  format: LocalMemoryFormat;
  errorPrefix: string;
}): ParsedMemoryMarkdown {
  const { content, relativePath, format, errorPrefix } = options;
  if (format === "memfs-v2" && isMemoryIndexPath(relativePath)) {
    if (/^---\r?\n/.test(content)) {
      throw new Error(`${errorPrefix}: MEMORY.md must not have frontmatter`);
    }
    return { frontmatter: {}, body: content };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `${errorPrefix}: target file is missing required frontmatter`,
    );
  }

  const fields = parseScalarFrontmatter(match[1] ?? "");
  const body = match[2] ?? "";
  const description = fields.get("description");
  if (!description?.trim()) {
    throw new Error(
      `${errorPrefix}: target file frontmatter is missing 'description'`,
    );
  }

  if (format === "memfs-v2") {
    const name = fields.get("name");
    if (!name?.trim()) {
      throw new Error(
        `${errorPrefix}: target file frontmatter is missing 'name'`,
      );
    }
    const keys = (match[1] ?? "").split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index).trim()] : [];
    });
    if (
      keys.length !== 2 ||
      !fields.has("name") ||
      !fields.has("description")
    ) {
      throw new Error(
        `${errorPrefix}: memory frontmatter must contain exactly 'name' and 'description'`,
      );
    }
    const parsedName = parseV2FrontmatterValue(name);
    const parsedDescription = parseV2FrontmatterValue(description);
    if (!parsedName.trim() || !parsedDescription.trim()) {
      throw new Error(
        `${errorPrefix}: memory 'name' and 'description' must not be empty`,
      );
    }
    return {
      frontmatter: {
        name: parsedName,
        description: parsedDescription,
      },
      body,
    };
  }

  const readOnly = fields.get("read_only");
  return {
    frontmatter: {
      description,
      ...(readOnly !== undefined ? { read_only: readOnly } : {}),
    },
    body,
  };
}

export function renderMemoryMarkdown(options: {
  frontmatter: MemoryMarkdownFrontmatter;
  body: string;
  relativePath: string;
  format: LocalMemoryFormat;
  errorPrefix: string;
}): string {
  const { frontmatter, body, relativePath, format, errorPrefix } = options;
  if (format === "memfs-v2" && isMemoryIndexPath(relativePath)) {
    return body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
  }

  const description = frontmatter.description?.trim();
  if (!description) {
    throw new Error(`${errorPrefix}: 'description' must not be empty`);
  }

  const lines = ["---"];
  if (format === "memfs-v2") {
    const name = frontmatter.name?.trim();
    if (!name) {
      throw new Error(`${errorPrefix}: 'name' must not be empty`);
    }
    lines.push(`name: ${JSON.stringify(sanitizeFrontmatterValue(name))}`);
    lines.push(
      `description: ${JSON.stringify(sanitizeFrontmatterValue(description))}`,
    );
  } else {
    lines.push(`description: ${sanitizeFrontmatterValue(description)}`);
    if (frontmatter.read_only !== undefined) {
      lines.push(`read_only: ${frontmatter.read_only}`);
    }
  }
  lines.push("---");
  const header = lines.join("\n");
  return body ? `${header}\n${body}` : `${header}\n`;
}
