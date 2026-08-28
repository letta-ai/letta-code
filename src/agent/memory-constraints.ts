/**
 * Self-contained validator installed beside the MemFS pre-commit hook.
 *
 * It runs under Node because Letta Code requires Node 22.19 or newer. Keeping
 * the validator dependency-free lets Git execute it from agent and shared
 * memory repositories without resolving the Letta Code package at commit time.
 *
 * The optional tracked `.letta-memory.json` file accepts:
 * - `maxFileCharacters`: a default cap for each projected memory Markdown file
 * - `fileCharacterLimits`: ordered glob overrides; the first match wins, and a
 *   null limit leaves matching files uncapped
 * - `maxDepth`: the number of directories allowed between the repo root and a
 *   projected memory file
 *
 * File limits count the complete staged file, including frontmatter.
 */

export const MEMORY_CONSTRAINTS_CONFIG_PATH = ".letta-memory.json";
export const MEMORY_CONSTRAINTS_VALIDATOR_NAME = "letta-memory-constraints.cjs";
export const MEMORY_CONSTRAINTS_UPDATE_ENV = "LETTA_MEMORY_CONSTRAINTS_UPDATE";

export const MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT = String.raw`"use strict";

const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const CONFIG_PATH = ${JSON.stringify(MEMORY_CONSTRAINTS_CONFIG_PATH)};
const CONFIG_UPDATE_ENV = ${JSON.stringify(MEMORY_CONSTRAINTS_UPDATE_ENV)};
const LAYOUT_POLICY_FILE = "letta-memory-layout-policy";
const ALLOWED_CONFIG_KEYS = new Set([
  "maxDepth",
  "maxFileCharacters",
  "fileCharacterLimits",
]);
const ALLOWED_OVERRIDE_KEYS = new Set(["pattern", "maxCharacters"]);

function runGit(args, encoding = "utf8") {
  return execFileSync("git", args, {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitSucceeds(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function stagedFile(path) {
  return runGit(["show", ":" + path]);
}

function stagedMode(path) {
  return runGit(["ls-files", "--stage", "--", path]).split(" ", 1)[0];
}

function stagedCharacterCount(path) {
  return new Promise((resolveCount, reject) => {
    const child = spawn("git", ["show", ":" + path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let characters = 0;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      characters += Array.from(chunk).length;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveCount(characters);
      } else {
        reject(new Error(stderr.trim() || "git show failed for " + path));
      }
    });
  });
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validatePattern(pattern, label, errors) {
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.startsWith("/") ||
    pattern.includes(String.fromCharCode(92)) ||
    pattern.split("/").includes("..")
  ) {
    errors.push(
      label + ": pattern must be a non-empty repo-relative glob using '/'",
    );
    return false;
  }
  if (
    pattern
      .split("/")
      .some((segment) => segment.includes("**") && segment !== "**")
  ) {
    errors.push(label + ": '**' must be a complete path segment");
    return false;
  }
  return true;
}

function parseConfig(content, errors) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    errors.push(CONFIG_PATH + ": invalid JSON (" + error.message + ")");
    return null;
  }

  if (!isPlainObject(value)) {
    errors.push(CONFIG_PATH + ": expected a JSON object");
    return null;
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      errors.push(CONFIG_PATH + ": unknown field '" + key + "'");
    }
  }

  if (
    value.maxDepth !== undefined &&
    !isNonNegativeInteger(value.maxDepth)
  ) {
    errors.push(CONFIG_PATH + ": maxDepth must be a non-negative integer");
  }
  if (
    value.maxFileCharacters !== undefined &&
    !isPositiveInteger(value.maxFileCharacters)
  ) {
    errors.push(
      CONFIG_PATH + ": maxFileCharacters must be a positive integer",
    );
  }

  const overrides = value.fileCharacterLimits;
  if (overrides !== undefined && !Array.isArray(overrides)) {
    errors.push(CONFIG_PATH + ": fileCharacterLimits must be an array");
  }
  if (Array.isArray(overrides)) {
    overrides.forEach((override, index) => {
      const label = CONFIG_PATH + ": fileCharacterLimits[" + index + "]";
      if (!isPlainObject(override)) {
        errors.push(label + " must be an object");
        return;
      }
      for (const key of Object.keys(override)) {
        if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
          errors.push(label + ": unknown field '" + key + "'");
        }
      }
      validatePattern(override.pattern, label, errors);
      if (
        override.maxCharacters !== null &&
        !isPositiveInteger(override.maxCharacters)
      ) {
        errors.push(label + ": maxCharacters must be a positive integer or null");
      }
    });
  }

  return value;
}

function escapeGlobRegExpCharacter(character) {
  return "^$.*+?()[]{}|".includes(character) || character.charCodeAt(0) === 92
    ? String.fromCharCode(92) + character
    : character;
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeGlobRegExpCharacter(character);
  }
  return new RegExp(source + "$");
}

function projectedV2Path(path, stagedPaths) {
  if (!path.includes("/")) return true;
  const directories = path.split("/").slice(0, -1);
  let current = "";
  for (const directory of directories) {
    current = current ? current + "/" + directory : directory;
    if (!stagedPaths.has(current + "/MEMORY.md")) return false;
  }
  return true;
}

function projectedLegacyPath(path) {
  return /^(?:memory\/)?(?:system|reference)\/.*\.md$/.test(path);
}

function listMemoryFiles(layoutPolicy) {
  const output = runGit(["ls-files", "-z", "--", "*.md"]);
  const paths = output.split("\0").filter(Boolean);
  const stagedPaths = new Set(paths);
  const hasRootMarker =
    stagedPaths.has("MEMORY.md") ||
    gitSucceeds(["cat-file", "-e", "HEAD:MEMORY.md"]);

  return paths.filter((path) => {
    if (path === "skills" || path.startsWith("skills/")) return false;
    if (layoutPolicy === "shared-memory") return true;
    if (layoutPolicy === "root-marker" && hasRootMarker) {
      return projectedV2Path(path, stagedPaths);
    }
    return projectedLegacyPath(path);
  });
}

function readLayoutPolicy() {
  try {
    const commonDir = runGit(["rev-parse", "--git-common-dir"]).trim();
    return readFileSync(resolve(commonDir, LAYOUT_POLICY_FILE), "utf8").trim();
  } catch {
    return "legacy-only";
  }
}

function characterLimitFor(path, config) {
  for (const override of config.fileCharacterLimits || []) {
    if (globToRegExp(override.pattern).test(path)) {
      return {
        limit: override.maxCharacters,
        source: "glob '" + override.pattern + "'",
      };
    }
  }
  return {
    limit: config.maxFileCharacters,
    source: "maxFileCharacters",
  };
}

function report(errors) {
  if (errors.length === 0) return;
  console.error("Memory constraints failed:");
  for (const error of errors) console.error("  " + error);
  process.exit(1);
}

async function main() {
  const errors = [];
  const configChanged = !gitSucceeds([
    "diff",
    "--cached",
    "--quiet",
    "--",
    CONFIG_PATH,
  ]);
  if (configChanged && process.env[CONFIG_UPDATE_ENV] !== "1") {
    errors.push(
      CONFIG_PATH + " is protected and requires human approval to change",
    );
  }

  if (!gitSucceeds(["cat-file", "-e", ":" + CONFIG_PATH])) {
    report(errors);
    return;
  }

  if (!stagedMode(CONFIG_PATH).startsWith("100")) {
    errors.push(CONFIG_PATH + ": constraint config must be a regular file");
    report(errors);
  }

  const config = parseConfig(stagedFile(CONFIG_PATH), errors);
  if (!config || errors.length > 0) report(errors);

  for (const path of listMemoryFiles(readLayoutPolicy())) {
    if (!stagedMode(path).startsWith("100")) {
      errors.push(path + ": memory Markdown must be a regular file");
      continue;
    }

    const depth = path.split("/").length - 1;
    if (config.maxDepth !== undefined && depth > config.maxDepth) {
      errors.push(
        path + ": depth " + depth + " exceeds maxDepth " + config.maxDepth,
      );
    }

    const constraint = characterLimitFor(path, config);
    if (constraint.limit === undefined || constraint.limit === null) continue;
    const characters = await stagedCharacterCount(path);
    if (characters > constraint.limit) {
      errors.push(
        path +
          ": " +
          characters +
          " characters exceeds " +
          constraint.limit +
          " from " +
          constraint.source,
      );
    }
  }

  report(errors);
}

main().catch((error) => {
  console.error("Memory constraints failed:");
  console.error("  " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
`;
