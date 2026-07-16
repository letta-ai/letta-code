#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_LINES = 1000;
const SOURCE_ROOTS = ["src", "scripts"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".ts", ".tsx"]);
const BASELINE_PATH = "scripts/source-file-size-baseline.json";

function findSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSourceFiles(filePath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(filePath.replace(/\\/g, "/"));
    }
  }
  return files;
}

function countLines(filePath) {
  const text = readFileSync(filePath, "utf8");
  if (text.length === 0) return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const files = SOURCE_ROOTS.flatMap(findSourceFiles).sort();
const counts = new Map(files.map((file) => [file, countLines(file)]));
const failures = [];

for (const [file, lines] of counts) {
  const allowedLines = baseline[file];
  if (lines <= MAX_LINES) {
    if (allowedLines !== undefined) {
      failures.push(
        `${file}: now ${lines} lines; remove its obsolete baseline entry`,
      );
    }
    continue;
  }

  if (allowedLines === undefined) {
    failures.push(
      `${file}: ${lines} lines exceeds the ${MAX_LINES}-line limit`,
    );
    continue;
  }
  if (lines > allowedLines) {
    failures.push(
      `${file}: grew from the ${allowedLines}-line baseline to ${lines} lines`,
    );
  } else if (lines < allowedLines) {
    failures.push(
      `${file}: shrank from ${allowedLines} to ${lines} lines; ratchet the baseline down`,
    );
  }
}

for (const file of Object.keys(baseline)) {
  if (!counts.has(file)) {
    failures.push(`${file}: baseline entry points to a missing source file`);
  }
}

if (failures.length > 0) {
  console.error("Source file size check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\nNew source files must stay at or below ${MAX_LINES} lines. Split oversized files by responsibility; only lower or remove baseline entries.`,
  );
  process.exit(1);
}

console.log(
  `Checked ${files.length} source files (maximum ${MAX_LINES} lines)`,
);
