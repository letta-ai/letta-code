/**
 * Self-contained validator installed beside the MemFS pre-commit hook.
 *
 * It runs under Node because Letta Code requires Node 22.19 or newer. Keeping
 * the validator dependency-free lets Git execute it from agent and shared
 * memory repositories without resolving the Letta Code package at commit time.
 *
 * The optional tracked `.memfs.config.json` file accepts:
 * - `version`: the required config format version (currently 1)
 * - `maxFileCharacters`: a default cap for each projected memory Markdown file
 * - `maxCoreMemoryCharacters`: a cap for all root Markdown loaded into a v2
 *   agent's system prompt
 * - `fileCharacterLimits`: ordered glob overrides; the first match wins, and a
 *   null limit leaves matching files uncapped
 * - `maxDepth`: the number of directories allowed between the repo root and a
 *   projected memory file
 *
 * File limits count the complete staged file, including frontmatter.
 */

import {
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  parseMemoryConstraintsConfig,
  validateMemoryTreeConstraints,
} from "@/memory-constraints";

export { MEMORY_CONSTRAINTS_CONFIG_PATH } from "@/memory-constraints";
export const MEMORY_CONSTRAINTS_VALIDATOR_NAME = "letta-memory-constraints.cjs";
export const MEMORY_CONSTRAINTS_UPDATE_ENV = "LETTA_MEMORY_CONSTRAINTS_UPDATE";

export const MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT = String.raw`"use strict";

const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const CONFIG_PATH = ${JSON.stringify(MEMORY_CONSTRAINTS_CONFIG_PATH)};
const parseMemoryConstraintsConfig = ${parseMemoryConstraintsConfig.toString()};
const validateMemoryTreeConstraints = ${validateMemoryTreeConstraints.toString()};
const DEFAULT_CONFIG = ${JSON.stringify(DEFAULT_MEMORY_CONSTRAINTS_CONFIG)};
const CONFIG_UPDATE_ENV = ${JSON.stringify(MEMORY_CONSTRAINTS_UPDATE_ENV)};
const LAYOUT_POLICY_FILE = "letta-memory-layout-policy";
const AUDIT_MODE = process.argv.includes("--audit");
let activeLayoutPolicy = "legacy-only";

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

function parseConfig(content, errors) {
  try {
    return parseMemoryConstraintsConfig(content);
  } catch (error) {
    errors.push(...error.message.split("\n"));
    return null;
  }
}

function readLayoutPolicy() {
  const layoutArgument = process.argv.indexOf("--layout");
  if (layoutArgument >= 0) {
    const policy = process.argv[layoutArgument + 1];
    if (["legacy-only", "root-marker", "shared-memory"].includes(policy)) {
      return policy;
    }
  }
  try {
    const commonDir = runGit(["rev-parse", "--git-common-dir"]).trim();
    return readFileSync(resolve(commonDir, LAYOUT_POLICY_FILE), "utf8").trim();
  } catch {
    return "legacy-only";
  }
}

function report(errors) {
  if (errors.length === 0) return;
  if (AUDIT_MODE) {
    console.error("Memory constraints failed:");
  } else {
    console.error("Memory validation blocked this commit.");
    console.error("No files were committed. Your staged changes are still present.");
    console.error(
      "Validation checks the complete repository, so these problems may predate your staged changes.",
    );
    console.error("");
    console.error("Fix these problems:");
  }
  for (const error of errors) console.error("  " + error);
  if (!AUDIT_MODE) {
    console.error("");
    if (activeLayoutPolicy === "root-marker") {
      console.error(
        "Move non-core detail out of root Markdown and behind MEMORY.md indexes.",
      );
    }
    console.error("Split files above their per-file limit, then retry the commit.");
    console.error(
      "Limits come from .memfs.config.json, or the Letta Code defaults when it is absent.",
    );
    console.error(
      "Do not raise or disable these limits unless the user explicitly approves it.",
    );
  }
  process.exit(1);
}

async function main() {
  const errors = [];
  const layoutPolicy = readLayoutPolicy();
  activeLayoutPolicy = layoutPolicy;
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

  const hasConfig = gitSucceeds(["cat-file", "-e", ":" + CONFIG_PATH]);
  const hasV2Root =
    layoutPolicy === "root-marker" &&
    (gitSucceeds(["cat-file", "-e", ":MEMORY.md"]) ||
      gitSucceeds(["cat-file", "-e", "HEAD:MEMORY.md"]));
  if (!hasConfig && !hasV2Root) {
    report(errors);
    return;
  }

  let config = DEFAULT_CONFIG;
  if (hasConfig) {
    if (!stagedMode(CONFIG_PATH).startsWith("100")) {
      errors.push(CONFIG_PATH + ": constraint config must be a regular file");
      report(errors);
    }

    const parsedConfig = parseConfig(stagedFile(CONFIG_PATH), errors);
    if (!parsedConfig || errors.length > 0) report(errors);
    config =
      layoutPolicy === "root-marker"
        ? { ...DEFAULT_CONFIG, ...parsedConfig }
        : parsedConfig;
  }

  errors.push(...await validateMemoryTreeConstraints({
    async countCharacters(path) {
      return new Promise((resolveCount, reject) => {
        const child = spawn("git", ["show", ":" + path], { stdio: ["ignore", "pipe", "pipe"] });
        let characters = 0;
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { for (const character of chunk) characters++; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolveCount(characters) : reject(new Error(stderr || "git show failed for " + path)));
      });
    },
    async listFiles() {
      return runGit(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map((entry) => {
        const separator = entry.indexOf("\t");
        return { path: entry.slice(separator + 1), mode: entry.split(" ", 1)[0] };
      });
    },
    async readFile(path) {
      return new Promise((resolveBytes, reject) => {
        const child = spawn("git", ["show", ":" + path], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        let stderr = "";
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolveBytes(Buffer.concat(chunks)) : reject(new Error(stderr || "git show failed for " + path)));
      });
    },
  }, { config, layout: layoutPolicy, requireRootMarker: gitSucceeds(["cat-file", "-e", "HEAD:MEMORY.md"]) }));

  report(errors);
}

main().catch((error) => {
  console.error("Memory constraints failed:");
  console.error("  " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
`;
