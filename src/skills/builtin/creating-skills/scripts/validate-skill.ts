#!/usr/bin/env -S npx tsx
/**
 * Skill Validator - checks a skill against the Agent Skills specification
 * (https://agentskills.io/specification), matching the skills-ref reference
 * validator.
 *
 * Usage:
 *   npx tsx validate-skill.ts <skill-directory>
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ValidationResult {
  valid: boolean;
  message: string;
  errors: string[];
}

const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

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
  const skillMdPath = join(skillPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return invalid(["Missing required file: SKILL.md"]);
  }

  const content = readFileSync(skillMdPath, "utf-8");
  if (!content.startsWith("---")) {
    return invalid(["SKILL.md must start with YAML frontmatter (---)"]);
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return invalid(["SKILL.md frontmatter not properly closed with ---"]);
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(match[1] as string);
  } catch (e) {
    return invalid([
      `Invalid YAML in frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }

  const errors: string[] = [];

  const unexpectedKeys = Object.keys(frontmatter).filter(
    (key) => !ALLOWED_PROPERTIES.has(key),
  );
  if (unexpectedKeys.length > 0) {
    errors.push(
      `Unexpected fields in frontmatter: ${unexpectedKeys.sort().join(", ")}. Only ${[...ALLOWED_PROPERTIES].sort().join(", ")} are allowed.`,
    );
  }

  if (!("name" in frontmatter)) {
    errors.push("Missing required field in frontmatter: name");
  } else {
    errors.push(
      ...validateName(frontmatter.name, basename(resolve(skillPath))),
    );
  }

  if (!("description" in frontmatter)) {
    errors.push("Missing required field in frontmatter: description");
  } else {
    errors.push(...validateDescription(frontmatter.description));
  }

  if ("compatibility" in frontmatter) {
    const compatibility = frontmatter.compatibility;
    if (typeof compatibility !== "string" || !compatibility.trim()) {
      errors.push("Field 'compatibility' must be a non-empty string");
    } else if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      errors.push(
        `Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} character limit (${compatibility.length} chars)`,
      );
    }
  }

  if ("metadata" in frontmatter) {
    const metadata = frontmatter.metadata;
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      Object.values(metadata).some((value) => typeof value !== "string")
    ) {
      errors.push(
        "Field 'metadata' must map string keys to string values (quote values like \"1.0\")",
      );
    }
  }

  for (const field of ["license", "allowed-tools"]) {
    if (field in frontmatter && typeof frontmatter[field] !== "string") {
      errors.push(`Field '${field}' must be a string`);
    }
  }

  return errors.length > 0
    ? invalid(errors)
    : { valid: true, message: "Skill is valid!", errors: [] };
}

function invalid(errors: string[]): ValidationResult {
  return { valid: false, message: errors.join("\n"), errors };
}

function validateName(name: unknown, directoryName: string): string[] {
  if (typeof name !== "string" || !name.trim()) {
    return ["Field 'name' must be a non-empty string"];
  }

  const errors: string[] = [];
  const normalized = name.trim().normalize("NFKC");
  if (normalized.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(
      `Skill name '${normalized}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${normalized.length} chars)`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    errors.push(
      `Skill name '${normalized}' may only contain lowercase letters, digits, and hyphens`,
    );
  }
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    errors.push("Skill name cannot start or end with a hyphen");
  }
  if (normalized.includes("--")) {
    errors.push("Skill name cannot contain consecutive hyphens");
  }
  if (directoryName.normalize("NFKC") !== normalized) {
    errors.push(
      `Directory name '${directoryName}' must match skill name '${normalized}'`,
    );
  }
  return errors;
}

function validateDescription(description: unknown): string[] {
  if (typeof description !== "string" || !description.trim()) {
    return ["Field 'description' must be a non-empty string"];
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      `Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${description.length} chars)`,
    ];
  }
  return [];
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

  const { valid, message, errors } = validateSkill(args[0] as string);
  if (valid) {
    console.log(message);
  } else {
    console.error("Skill is invalid:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
  }
  process.exit(valid ? 0 : 1);
}
