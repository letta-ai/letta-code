#!/usr/bin/env npx ts-node
/**
 * Skill Validator - Validates skill structure and frontmatter
 *
 * Usage:
 *   npx ts-node validate-skill.ts <skill-directory>
 *
 * Example:
 *   npx ts-node validate-skill.ts .skills/my-skill
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

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
    frontmatter = parseYaml(frontmatterText);
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

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log("Usage: npx ts-node validate-skill.ts <skill-directory>");
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
