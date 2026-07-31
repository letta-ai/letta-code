#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const categories = new Set([
  "smooth-path",
  "discovery",
  "installation",
  "types-api",
  "lifecycle",
  "tools-permissions",
  "events-provenance",
  "deployment",
  "docs-examples",
  "performance-cost",
  "other",
]);

const frictionLevels = new Set(["none", "low", "medium", "high", "blocking"]);
const surfaces = new Set(["cloud", "local", "remote", "app-server"]);
const scalarKeys = new Set([
  "category",
  "friction",
  "summary",
  "expected",
  "observed",
  "suggestion",
  "workaround",
  "surface",
  "sdk-version",
  "run-id",
  "project",
  "output",
]);
const sensitiveValuePatterns = [
  /\b(?:api[_ -]?key|authorization|password|secret)\s*[:=]\s*\S+/i,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(?:gh[opusr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,})\b/i,
];

function usage() {
  return `Usage:
  node log-feedback.mjs \\
    --category <category> \\
    --friction <none|low|medium|high|blocking> \\
    --summary <short summary> \\
    --expected <expected behavior> \\
    --observed <observed behavior> \\
    --evidence <sanitized evidence> [--evidence <more>] \\
    [--suggestion <specific improvement>] \\
    [--workaround <sanitized workaround>] \\
    [--artifact <path-or-receipt>] [--command <sanitized command>] \\
    [--surface <cloud|local|remote|app-server>] \\
    [--sdk-version <version>] [--run-id <id>] \\
    [--project <path>] [--output <jsonl-path>]

Categories: ${[...categories].join(", ")}

Do not include credentials, authorization headers, private prompts, customer
data, raw environment values, or full model output.`;
}

function fail(message) {
  console.error(`Error: ${message}\n\n${usage()}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const repeated = new Map([
    ["evidence", []],
    ["artifact", []],
    ["command", []],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!scalarKeys.has(key) && !repeated.has(key)) {
      fail(`Unknown option: --${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    index += 1;
    if (repeated.has(key)) repeated.get(key).push(value);
    else if (values.has(key)) fail(`Duplicate --${key}`);
    else values.set(key, value);
  }

  return { values, repeated };
}

function optional(values, key) {
  return values.get(key) || null;
}

function required(values, key) {
  const value = values.get(key)?.trim();
  if (!value) fail(`--${key} is required`);
  return value;
}

function gitValue(projectPath, args) {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function findSdkVersion(projectPath) {
  let current = projectPath;
  while (true) {
    const packagePath = join(
      current,
      "node_modules",
      "@letta-ai",
      "letta-agent-sdk",
      "package.json",
    );
    try {
      return JSON.parse(readFileSync(packagePath, "utf8")).version ?? null;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function rejectLikelySecrets(values) {
  for (const value of values) {
    if (sensitiveValuePatterns.some((pattern) => pattern.test(value))) {
      fail("Feedback appears to contain a credential or secret assignment");
    }
  }
}

function main() {
  const { values, repeated } = parseArgs(process.argv.slice(2));
  const category = required(values, "category");
  const friction = required(values, "friction");
  const summary = required(values, "summary");
  const expected = required(values, "expected");
  const observed = required(values, "observed");
  const evidence = repeated
    .get("evidence")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!categories.has(category)) fail(`Unknown category: ${category}`);
  if (!frictionLevels.has(friction))
    fail(`Unknown friction level: ${friction}`);
  const surface = optional(values, "surface");
  if (surface && !surfaces.has(surface)) fail(`Unknown surface: ${surface}`);
  if (evidence.length === 0) fail("At least one --evidence value is required");
  if (friction !== "none" && !optional(values, "suggestion")) {
    fail("--suggestion is required when friction is nonzero");
  }
  rejectLikelySecrets([
    summary,
    expected,
    observed,
    ...evidence,
    ...repeated.get("artifact"),
    ...repeated.get("command"),
    ...[optional(values, "suggestion"), optional(values, "workaround")].filter(
      Boolean,
    ),
  ]);

  const projectInput = resolve(optional(values, "project") ?? process.cwd());
  let projectPath;
  try {
    projectPath = realpathSync(projectInput);
  } catch {
    fail(`Project path does not exist: ${projectInput}`);
  }

  const outputPath = resolve(
    optional(values, "output") ??
      join(projectPath, ".letta", "letta-agent-sdk-feedback.jsonl"),
  );

  const gitRoot = gitValue(projectPath, ["rev-parse", "--show-toplevel"]);
  const gitCommit = gitValue(projectPath, ["rev-parse", "HEAD"]);
  const gitBranch = gitValue(projectPath, ["branch", "--show-current"]);
  const gitStatus = gitValue(projectPath, ["status", "--porcelain=v1"]);

  const record = {
    schemaVersion: 1,
    id: `sdk-feedback-${randomUUID()}`,
    recordedAt: new Date().toISOString(),
    category,
    friction,
    summary,
    expected,
    observed,
    evidence,
    suggestion: optional(values, "suggestion"),
    workaround: optional(values, "workaround"),
    artifacts: repeated.get("artifact"),
    commands: repeated.get("command"),
    runId: optional(values, "run-id"),
    sdk: {
      package: "@letta-ai/letta-agent-sdk",
      version: optional(values, "sdk-version") ?? findSdkVersion(projectPath),
      surface,
    },
    provenance: {
      projectPath,
      gitRoot,
      gitCommit,
      gitBranch,
      gitDirty: gitStatus === null ? null : gitStatus.length > 0,
      agentId: process.env.AGENT_ID ?? null,
      conversationId: process.env.CONVERSATION_ID ?? null,
      nodeVersion: process.version,
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  appendFileSync(outputPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  console.log(`Recorded Agent SDK feedback: ${outputPath}`);
  console.log(`Feedback ID: ${record.id}`);
}

main();
