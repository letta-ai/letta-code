#!/usr/bin/env bun
/**
 * Skill Initializer - Creates a new skill from template
 *
 * Usage:
 *   bun init-skill.ts <skill-name> --path <path>
 *
 * Examples:
 *   bun init-skill.ts my-new-skill --path .skills
 *   bun init-skill.ts my-api-helper --path ~/.letta/skills
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SKILL_TEMPLATE = `---
name: {skill_name}
description: "[TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]"
---

# {skill_title}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Structuring This Skill

[TODO: Choose the structure that best fits this skill's purpose. Common patterns:

**1. Workflow-Based** (best for sequential processes)
- Works well when there are clear step-by-step procedures
- Example: DOCX skill with "Workflow Decision Tree" → "Reading" → "Creating" → "Editing"
- Structure: ## Overview → ## Workflow Decision Tree → ## Step 1 → ## Step 2...

**2. Task-Based** (best for tool collections)
- Works well when the skill offers different operations/capabilities
- Example: PDF skill with "Quick Start" → "Merge PDFs" → "Split PDFs" → "Extract Text"
- Structure: ## Overview → ## Quick Start → ## Task Category 1 → ## Task Category 2...

**3. Reference/Guidelines** (best for standards or specifications)
- Works well for brand guidelines, coding standards, or requirements
- Example: Brand styling with "Brand Guidelines" → "Colors" → "Typography" → "Features"
- Structure: ## Overview → ## Guidelines → ## Specifications → ## Usage...

**4. Capabilities-Based** (best for integrated systems)
- Works well when the skill provides multiple interrelated features
- Example: Product Management with "Core Capabilities" → numbered capability list
- Structure: ## Overview → ## Core Capabilities → ### 1. Feature → ### 2. Feature...

Patterns can be mixed and matched as needed. Most skills combine patterns (e.g., start with task-based, add workflow for complex operations).

Delete this entire "Structuring This Skill" section when done - it's just guidance.]

## [TODO: Replace with the first main section based on chosen structure]

[TODO: Add content here. See examples in existing skills:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/templates/references as needed]

## Resources

This skill includes example resource directories that demonstrate how to organize different types of bundled resources:

### scripts/
Executable code (TypeScript/Python/Bash/etc.) that can be run directly to perform specific operations.

**Appropriate for:** Scripts that perform automation, data processing, or specific operations.

**Note:** Scripts may be executed without loading into context, but can still be read by the Letta Code agent for patching or environment adjustments.

### references/
Documentation and reference material intended to be loaded into context to inform the Letta Code agent's process and thinking.

**Appropriate for:** In-depth documentation, API references, database schemas, comprehensive guides, or any detailed information that the Letta Code agent should reference while working.

### assets/
Files not intended to be loaded into context, but rather used within the output the Letta Code agent produces.

**Appropriate for:** Templates, boilerplate code, document templates, images, icons, fonts, or any files meant to be copied or used in the final output.

---

**Any unneeded directories can be deleted.** Not every skill requires all three types of resources.
`;

const EXAMPLE_SCRIPT = `#!/usr/bin/env bun
/**
 * Example helper script for {skill_name}
 *
 * This is a placeholder script that can be executed directly.
 * Replace with actual implementation or delete if not needed.
 */

function main() {
  console.log("This is an example script for {skill_name}");
  // TODO: Add actual script logic here
  // This could be data processing, file conversion, API calls, etc.
}

main();
`;

const EXAMPLE_REFERENCE = `# Reference Documentation for {skill_title}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

## When Reference Docs Are Useful

Reference docs are ideal for:
- Comprehensive API documentation
- Detailed workflow guides
- Complex multi-step processes
- Information too lengthy for main SKILL.md
- Content that's only needed for specific use cases

## Structure Suggestions

### API Reference Example
- Overview
- Authentication
- Endpoints with examples
- Error codes
- Rate limits

### Workflow Guide Example
- Prerequisites
- Step-by-step instructions
- Common patterns
- Troubleshooting
- Best practices
`;

const EXAMPLE_ASSET = `# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output the Letta Code agent produces.

## Common Asset Types

- Templates: .pptx, .docx, boilerplate directories
- Images: .png, .jpg, .svg, .gif
- Fonts: .ttf, .otf, .woff, .woff2
- Boilerplate code: Project directories, starter files
- Icons: .ico, .svg
- Data files: .csv, .json, .xml, .yaml

Note: This is a text placeholder. Actual assets can be any file type.
`;

function titleCaseSkillName(skillName: string): string {
  return skillName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function initSkill(skillName: string, path: string): string | null {
  const skillDir = resolve(path, skillName);

  // Check if directory already exists
  if (existsSync(skillDir)) {
    console.error(`Error: Skill directory already exists: ${skillDir}`);
    return null;
  }

  // Create skill directory
  try {
    mkdirSync(skillDir, { recursive: true });
    console.log(`Created skill directory: ${skillDir}`);
  } catch (e) {
    console.error(
      `Error creating directory: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  const skillTitle = titleCaseSkillName(skillName);

  // Create SKILL.md from template
  const skillContent = SKILL_TEMPLATE.replace(
    /{skill_name}/g,
    skillName,
  ).replace(/{skill_title}/g, skillTitle);

  try {
    writeFileSync(join(skillDir, "SKILL.md"), skillContent);
    console.log("Created SKILL.md");
  } catch (e) {
    console.error(
      `Error creating SKILL.md: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  // Create resource directories with example files
  try {
    // Create scripts/ directory with example script
    const scriptsDir = join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const exampleScriptPath = join(scriptsDir, "example.ts");
    writeFileSync(
      exampleScriptPath,
      EXAMPLE_SCRIPT.replace(/{skill_name}/g, skillName),
    );
    chmodSync(exampleScriptPath, 0o755);
    console.log("Created scripts/example.ts");

    // Create references/ directory with example reference doc
    const referencesDir = join(skillDir, "references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(
      join(referencesDir, "api-reference.md"),
      EXAMPLE_REFERENCE.replace(/{skill_title}/g, skillTitle),
    );
    console.log("Created references/api-reference.md");

    // Create assets/ directory with example asset placeholder
    const assetsDir = join(skillDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "example-asset.txt"), EXAMPLE_ASSET);
    console.log("Created assets/example-asset.txt");
  } catch (e) {
    console.error(
      `Error creating resource directories: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  // Print next steps
  console.log(`\nSkill '${skillName}' initialized successfully at ${skillDir}`);
  console.log("\nNext steps:");
  console.log(
    "1. Edit SKILL.md to complete the TODO items and update the description",
  );
  console.log(
    "2. Customize or delete the example files in scripts/, references/, and assets/",
  );
  console.log("3. Run the validator when ready to check the skill structure");

  return skillDir;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 3 || args[1] !== "--path") {
    console.log("Usage: bun init-skill.ts <skill-name> --path <path>");
    console.log("\nSkill name requirements:");
    console.log("  - Hyphen-case identifier (e.g., 'data-analyzer')");
    console.log("  - Lowercase letters, digits, and hyphens only");
    console.log("  - Max 64 characters");
    console.log("  - Must match directory name exactly");
    console.log("\nExamples:");
    console.log("  bun init-skill.ts my-new-skill --path .skills");
    console.log(
      "  bun init-skill.ts my-api-helper --path ~/.letta/skills",
    );
    process.exit(1);
  }

  const skillName = args[0] as string;
  const path = args[2] as string;

  console.log(`Initializing skill: ${skillName}`);
  console.log(`Location: ${path}\n`);

  const result = initSkill(skillName, path);
  process.exit(result ? 0 : 1);
}

export { initSkill, titleCaseSkillName };
