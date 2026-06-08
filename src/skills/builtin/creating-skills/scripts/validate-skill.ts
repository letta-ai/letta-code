#!/usr/bin/env -S npx tsx
/**
 * Skill Validator - Validates skill structure and frontmatter
 *
 * Usage:
 *   npx tsx validate-skill.ts <skill-directory>
 *
 * Example:
 *   npx tsx validate-skill.ts .skills/my-skill
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ValidationResult {
  valid: boolean;
  message: string;
  warnings?: string[];
}

const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

type BunYamlRuntime = {
  Bun?: {
    YAML?: {
      parse?: (source: string) => unknown;
    };
  };
};

function parseQuotedScalar(value: string): string {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      throw new Error("Unterminated double-quoted scalar");
    }
    return JSON.parse(value) as string;
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      throw new Error("Unterminated single-quoted scalar");
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuotedScalar(trimmed);
  }

  // The fallback parser intentionally accepts only the frontmatter subset this
  // validator needs. Unquoted ": " inside a scalar is the most common YAML
  // authoring mistake; reject it instead of silently producing a bad value.
  if (trimmed.includes(": ")) {
    throw new Error(`Unexpected ':' in unquoted scalar: ${trimmed}`);
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseFrontmatterFallback(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (/^\s/.test(line)) {
      // Nested data belongs to the previous top-level key. The validator only
      // checks top-level field names plus name/description scalar values.
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (!key) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    if (!rawValue) {
      result[key] = {};
      continue;
    }

    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine === undefined) continue;
        if (nextLine.trim() && !/^\s/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine.replace(/^\s{2}/, ""));
        i = j;
      }
      result[key] =
        rawValue === ">" ? blockLines.join(" ").trim() : blockLines.join("\n");
      continue;
    }

    result[key] = parseScalar(rawValue);
  }

  return result;
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const bunParse = (globalThis as typeof globalThis & BunYamlRuntime).Bun?.YAML
    ?.parse;
  if (bunParse) {
    const parsed = bunParse(source);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Frontmatter must be a YAML dictionary");
    }
    return parsed as Record<string, unknown>;
  }

  return parseFrontmatterFallback(source);
}

export function validateSkill(skillPath: string): ValidationResult {
  // Check SKILL.md exists
  const skillMdPath = join(skillPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return { valid: false, message: "SKILL.md not found" };
  }

  // Read content
  const content = readFileSync(skillMdPath, "utf-8");

  // Check for frontmatter
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  // Extract frontmatter
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { valid: false, message: "Invalid frontmatter format" };
  }

  const frontmatterText = match[1] as string;

  // Parse YAML frontmatter
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
    if (typeof frontmatter !== "object" || frontmatter === null) {
      return { valid: false, message: "Frontmatter must be a YAML dictionary" };
    }
  } catch (e) {
    return {
      valid: false,
      message: `Invalid YAML in frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Check for unexpected properties (warn but don't fail for forward-compatibility)
  const warnings: string[] = [];
  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !ALLOWED_PROPERTIES.has(key),
  );
  if (unexpectedKeys.length > 0) {
    warnings.push(
      `Unknown frontmatter key(s): ${unexpectedKeys.sort().join(", ")}. Known properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`,
    );
  }

  // Check required fields
  if (!("name" in frontmatter)) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  // Validate name
  const name = frontmatter.name;
  if (typeof name !== "string") {
    return {
      valid: false,
      message: `Name must be a string, got ${typeof name}`,
    };
  }
  const trimmedName = name.trim();
  if (trimmedName) {
    // Check naming convention (hyphen-case: lowercase with hyphens)
    if (!/^[a-z0-9-]+$/.test(trimmedName)) {
      return {
        valid: false,
        message: `Name '${trimmedName}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (
      trimmedName.startsWith("-") ||
      trimmedName.endsWith("-") ||
      trimmedName.includes("--")
    ) {
      return {
        valid: false,
        message: `Name '${trimmedName}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    // Check name length (max 64 characters)
    if (trimmedName.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${trimmedName.length} characters). Maximum is 64 characters.`,
      };
    }

    // Check name matches directory name (warn if not)
    const dirName = basename(skillPath);
    if (trimmedName !== dirName) {
      warnings.push(
        `Name '${trimmedName}' doesn't match directory name '${dirName}'. For portability, these should match.`,
      );
    }
  }

  // Validate description
  const description = frontmatter.description;
  if (typeof description !== "string") {
    return {
      valid: false,
      message: `Description must be a string, got ${typeof description}`,
    };
  }
  const trimmedDescription = description.trim();
  if (trimmedDescription) {
    // Check for angle brackets
    if (trimmedDescription.includes("<") || trimmedDescription.includes(">")) {
      return {
        valid: false,
        message: "Description cannot contain angle brackets (< or >)",
      };
    }
    // Check description length (max 1024 characters)
    if (trimmedDescription.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${trimmedDescription.length} characters). Maximum is 1024 characters.`,
      };
    }
  }

  return {
    valid: true,
    message: "Skill is valid!",
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint
    ? resolve(entrypoint) === fileURLToPath(import.meta.url)
    : false;
}

// CLI entry point
if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log("Usage: npx tsx validate-skill.ts <skill-directory>");
    process.exit(1);
  }

  const { valid, message, warnings } = validateSkill(args[0] as string);
  console.log(message);
  if (warnings && warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }
  process.exit(valid ? 0 : 1);
}
