#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const isStagedOnly = process.argv.includes("--staged");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "git command failed").trim(),
    );
  }

  return result.stdout;
}

function splitNul(output) {
  return output.split("\0").filter(Boolean);
}

function isSkillMarkdownFile(file) {
  return file.split(/[\\/]/).pop() === "SKILL.md";
}

function getCandidateFiles() {
  if (isStagedOnly) {
    return splitNul(
      git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]),
    ).filter(isSkillMarkdownFile);
  }

  return splitNul(git(["ls-files", "-z"])).filter(isSkillMarkdownFile);
}

function readStagedFile(file) {
  return git(["show", `:${file}`]);
}

function readCurrentFile(file) {
  if (!existsSync(file)) {
    return null;
  }
  return readFileSync(file, "utf8");
}

function checkSkillFrontmatterName(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return "missing YAML frontmatter";
  }

  const frontmatter = match[1] ?? "";
  const nameLine = frontmatter
    .split("\n")
    .find((line) => /^\s*name\s*:/.test(line));

  if (!nameLine) {
    return "missing name frontmatter";
  }

  const nameValue = nameLine.replace(/^\s*name\s*:\s*/, "").trim();
  if (!nameValue) {
    return "empty name frontmatter";
  }

  return null;
}

let violations = [];
let files = [];
try {
  files = getCandidateFiles();
  violations = files.flatMap((file) => {
    const content = isStagedOnly ? readStagedFile(file) : readCurrentFile(file);
    if (content === null) {
      return [];
    }

    const reason = checkSkillFrontmatterName(content);
    return reason ? [{ file, reason }] : [];
  });
} catch (error) {
  console.error(
    `Failed to check skill frontmatter: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error("\n❌ Skill frontmatter violations found:\n");
  for (const violation of violations) {
    console.error(`${violation.file}`);
    console.error(`  ${violation.reason}`);
    console.error(
      "  ↳ Add a non-empty `name:` field to SKILL.md frontmatter.\n",
    );
  }
  console.error(
    `Found ${violations.length} skill frontmatter violation${violations.length === 1 ? "" : "s"}.`,
  );
  process.exit(1);
}

if (!isStagedOnly) {
  console.log(
    `✅ Skill frontmatter name headers present (${files.length} SKILL.md file${files.length === 1 ? "" : "s"}).`,
  );
}
