#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";

const rootDir = process.cwd();

const ARROW_EXPORT = /^export const \w+ = (async )?\(/;

const files = await glob("src/**/*.ts", {
  cwd: rootDir,
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"],
});

let violations = 0;

for (const file of files.sort()) {
  const content = readFileSync(join(rootDir, file), "utf-8");
  const lines = content.split("\n");

  lines.forEach((line, i) => {
    if (ARROW_EXPORT.test(line)) {
      if (violations === 0) {
        console.error("\n❌ Exported arrow functions found:\n");
      }
      console.error(`  ${file}:${i + 1}`);
      console.error(`    ${line.trim()}`);
      console.error(
        `    ↳ Use 'export function name() {}' instead of 'export const name = () =>'\n`,
      );
      violations++;
    }
  });
}

if (violations > 0) {
  console.error(
    `Found ${violations} exported arrow function${violations === 1 ? "" : "s"}.`,
  );
  process.exit(1);
} else {
  console.log("✅ No exported arrow functions found.");
}
