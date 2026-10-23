/**
 * Tests for the bundled creating-skills validator
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateSkill } from "@/skills/builtin/creating-skills/scripts/validate-skill";

const TEST_DIR = join(import.meta.dir, ".test-skill-creator");

describe("validate-skill", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("validates a valid skill", () => {
    const skillDir = join(TEST_DIR, "valid-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: valid-skill
description: A valid test skill
---

# Valid Skill

This is a valid skill.
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(true);
    expect(result.message).toBe("Skill is valid!");
  });

  test("fails when SKILL.md is missing", () => {
    const skillDir = join(TEST_DIR, "missing-skill");
    mkdirSync(skillDir);

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toBe("Missing required file: SKILL.md");
  });

  test("fails when frontmatter is missing", () => {
    const skillDir = join(TEST_DIR, "no-frontmatter");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `# No Frontmatter

This skill has no frontmatter.
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toBe(
      "SKILL.md must start with YAML frontmatter (---)",
    );
  });

  test("fails when name is missing", () => {
    const skillDir = join(TEST_DIR, "no-name");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
description: A skill without a name
---

# No Name
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Missing required field in frontmatter: name",
    );
  });

  test("fails when description is missing", () => {
    const skillDir = join(TEST_DIR, "no-description");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: no-description
---

# No Description
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Missing required field in frontmatter: description",
    );
  });

  test("fails when name has invalid characters", () => {
    const skillDir = join(TEST_DIR, "invalid-name");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: Invalid_Name
description: A skill with invalid name
---

# Invalid Name
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toContain(
      "may only contain lowercase letters, digits, and hyphens",
    );
  });

  test("fails when name starts with hyphen", () => {
    const skillDir = join(TEST_DIR, "hyphen-start");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: -invalid-start
description: A skill with invalid name
---

# Invalid Start
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Skill name cannot start or end with a hyphen",
    );
  });

  test("fails when frontmatter has fields outside the specification", () => {
    const skillDir = join(TEST_DIR, "unknown-keys");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: unknown-keys
description: A skill with unknown keys
author: Someone
version: 1.0.0
---

# Unknown Keys
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toContain(
      "Unexpected fields in frontmatter: author, version",
    );
  });

  test("accepts all specification frontmatter fields", () => {
    const skillDir = join(TEST_DIR, "full-spec");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: full-spec
description: A skill with all official spec fields
license: MIT
compatibility: Requires Node.js 18+
metadata:
  author: test
  version: "1.0"
allowed-tools: Bash Read Write
---

# Full Spec Skill
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("fails when unquoted frontmatter contains colon-space", () => {
    const skillDir = join(TEST_DIR, "bad-colon");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: bad-colon
description: This breaks: unless quoted
---

# Bad Colon
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("Invalid YAML in frontmatter");
  });

  test("runs from a node_modules path without external dependencies", () => {
    const fakePackageScriptsDir = join(
      TEST_DIR,
      "app",
      "node_modules",
      "@letta-ai",
      "letta-code",
      "skills",
      "creating-skills",
      "scripts",
    );
    mkdirSync(fakePackageScriptsDir, { recursive: true });
    copyFileSync(
      join(
        import.meta.dir,
        "builtin",
        "creating-skills",
        "scripts",
        "validate-skill.ts",
      ),
      join(fakePackageScriptsDir, "validate-skill.ts"),
    );
    const skillDir = join(TEST_DIR, "self-contained-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: self-contained-skill
description: A valid test skill
---

# Self-contained Skill
`,
    );

    const env = { ...process.env };
    delete env.NODE_PATH;

    const validateResult = spawnSync(
      process.execPath,
      [join(fakePackageScriptsDir, "validate-skill.ts"), skillDir],
      { cwd: join(TEST_DIR, "app"), env, encoding: "utf8" },
    );
    expect(validateResult.status).toBe(0);
    expect(validateResult.stderr).toBe("");
    expect(validateResult.stdout).toContain("Skill is valid!");
  });

  test("fails when name doesn't match directory name", () => {
    const skillDir = join(TEST_DIR, "my-directory");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: different-name
description: Name doesn't match directory
---

# Mismatched Name
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      "Directory name 'my-directory' must match skill name 'different-name'",
    ]);
  });

  test("enforces specification length and value limits", () => {
    const longName = "a".repeat(65);
    const skillDir = join(TEST_DIR, longName);
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: ${longName}
description: "${"d".repeat(1025)}"
compatibility: "${"c".repeat(501)}"
metadata:
  version: 1.0
---
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      `Skill name '${longName}' exceeds 64 character limit (65 chars)`,
      "Description exceeds 1024 character limit (1025 chars)",
      "Compatibility exceeds 500 character limit (501 chars)",
      "Field 'metadata' must map string keys to string values (quote values like \"1.0\")",
    ]);
  });

  test("fails on consecutive hyphens and empty description", () => {
    const skillDir = join(TEST_DIR, "pdf--processing");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: pdf--processing
description: ""
---
`,
    );

    const result = validateSkill(skillDir);
    expect(result.errors).toEqual([
      "Skill name cannot contain consecutive hyphens",
      "Field 'description' must be a non-empty string",
    ]);
  });

  test("validates this skill itself", () => {
    const skillDir = join(import.meta.dir, "builtin", "creating-skills");
    expect(validateSkill(skillDir)).toEqual({
      valid: true,
      message: "Skill is valid!",
      errors: [],
    });
  });
});
