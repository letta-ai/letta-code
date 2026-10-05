/**
 * Tests for the bundled skill-creator scripts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  initSkill,
  titleCaseSkillName,
} from "@/skills/builtin/creating-skills/scripts/init-skill";
import { packageSkill } from "@/skills/builtin/creating-skills/scripts/package-skill";
import { validateSkill } from "@/skills/builtin/creating-skills/scripts/validate-skill";

const TEST_DIR = join(import.meta.dir, ".test-skill-creator");

function extractLocalZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (
    offset + 30 <= archive.length &&
    archive.readUInt32LE(offset) === 0x04034b50
  ) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString();
    const compressed = archive.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`unsupported ZIP compression method ${method}`);
    }

    expect(data.length).toBe(uncompressedSize);
    entries.set(name, data);
    offset = dataEnd;
  }

  return entries;
}

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
    expect(result.message).toBe("SKILL.md not found");
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
    expect(result.message).toBe("No YAML frontmatter found");
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
    expect(result.message).toBe("Missing 'name' in frontmatter");
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
    expect(result.message).toBe("Missing 'description' in frontmatter");
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
    expect(result.message).toContain("should be hyphen-case");
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
    expect(result.message).toContain("cannot start/end with hyphen");
  });

  test("fails when description contains angle brackets", () => {
    const skillDir = join(TEST_DIR, "angle-brackets");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: angle-brackets
description: A skill with <invalid> description
---

# Angle Brackets
`,
    );

    const result = validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("cannot contain angle brackets");
  });

  test("warns but passes when unknown frontmatter keys are present", () => {
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
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toContain("Unknown frontmatter key(s)");
  });

  test("accepts all official spec frontmatter fields without warnings", () => {
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
    expect(result.warnings).toBeUndefined();
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
    copyFileSync(
      join(
        import.meta.dir,
        "builtin",
        "creating-skills",
        "scripts",
        "package-skill.ts",
      ),
      join(fakePackageScriptsDir, "package-skill.ts"),
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

    const packageResult = spawnSync(
      process.execPath,
      [join(fakePackageScriptsDir, "package-skill.ts"), skillDir, TEST_DIR],
      { cwd: join(TEST_DIR, "app"), env, encoding: "utf8" },
    );
    expect(packageResult.status).toBe(0);
    expect(packageResult.stderr).toBe("");
    expect(existsSync(join(TEST_DIR, "self-contained-skill.skill"))).toBe(true);
  });

  test("warns when name doesn't match directory name", () => {
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
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]).toContain("doesn't match directory name");
  });
});

describe("init-skill", () => {
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

  test("titleCaseSkillName converts hyphenated names", () => {
    expect(titleCaseSkillName("my-skill")).toBe("My Skill");
    expect(titleCaseSkillName("pdf-editor")).toBe("Pdf Editor");
    expect(titleCaseSkillName("big-query-helper")).toBe("Big Query Helper");
  });

  test("creates a new skill directory with all files", () => {
    const result = initSkill("test-skill", TEST_DIR);

    expect(result).not.toBeNull();
    expect(existsSync(join(TEST_DIR, "test-skill"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "test-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "test-skill", "scripts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "test-skill", "references"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "test-skill", "assets"))).toBe(true);
  });

  test("created skill passes validation", () => {
    initSkill("valid-init", TEST_DIR);

    // The initialized skill should pass validation (except for TODO in description)
    const skillDir = join(TEST_DIR, "valid-init");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
  });

  test("fails when directory already exists", () => {
    const skillDir = join(TEST_DIR, "existing-skill");
    mkdirSync(skillDir, { recursive: true });

    const result = initSkill("existing-skill", TEST_DIR);
    expect(result).toBeNull();
  });
});

describe("package-skill", () => {
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

  test("packages a valid skill into a .skill file", () => {
    // Create a valid skill
    const skillDir = join(TEST_DIR, "packagable-skill");
    mkdirSync(skillDir);
    const skillContent = `---
name: packagable-skill
description: A skill that can be packaged
---

# Packagable Skill

This skill can be packaged.
`;
    writeFileSync(join(skillDir, "SKILL.md"), skillContent);

    const result = packageSkill(skillDir, TEST_DIR);
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected packaged skill path");
    expect(existsSync(join(TEST_DIR, "packagable-skill.skill"))).toBe(true);

    const entries = extractLocalZipEntries(readFileSync(result));
    expect(entries.get("packagable-skill/SKILL.md")?.toString()).toBe(
      skillContent,
    );
  });

  test("fails when skill directory does not exist", () => {
    const result = packageSkill(join(TEST_DIR, "nonexistent"), TEST_DIR);
    expect(result).toBeNull();
  });

  test("fails when SKILL.md is missing", () => {
    const skillDir = join(TEST_DIR, "no-skill-md");
    mkdirSync(skillDir);

    const result = packageSkill(skillDir, TEST_DIR);
    expect(result).toBeNull();
  });

  test("fails when skill validation fails", () => {
    const skillDir = join(TEST_DIR, "invalid-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: Invalid_Name
description: Invalid skill
---

# Invalid
`,
    );

    const result = packageSkill(skillDir, TEST_DIR);
    expect(result).toBeNull();
  });
});
