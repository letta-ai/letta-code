#!/usr/bin/env node

/**
 * Enforces that bundled skill scripts are self-contained.
 *
 * Built-in skills are shipped as standalone resources, including inside app
 * bundles where they can live below node_modules/. A script that imports a bare
 * package specifier can fail there because Bun disables auto-install when any
 * node_modules directory exists up the tree. Keep bundled scripts limited to
 * relative imports and runtime built-ins, or invoke lazy resolvers explicitly
 * from SKILL.md (npx/uvx/uv run/etc.) instead of relying on a manifest install.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const rootDir = process.cwd();
const builtinSkillDir = join(rootDir, "src", "skills", "builtin");

const scriptExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
]);
const forbiddenManifestNames = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const builtinNames = new Set(
  builtinModules.flatMap((name) => {
    const bare = name.startsWith("node:") ? name.slice("node:".length) : name;
    return [bare, `node:${bare}`];
  }),
);

function walk(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function toRepoPath(file) {
  return file.slice(rootDir.length + 1).replace(/\\/g, "/");
}

function extensionOf(file) {
  const basename = file.split(/[\\/]/).pop() ?? file;
  if (basename.endsWith(".d.ts")) return ".d.ts";
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex === -1 ? "" : basename.slice(dotIndex);
}

function isScriptFile(file) {
  return scriptExtensions.has(extensionOf(file));
}

function isRuntimeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  return (
    builtinNames.has(specifier) || builtinNames.has(specifier.split("/")[0])
  );
}

function isAllowedScriptImport(specifier) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    isRuntimeBuiltin(specifier)
  );
}

function lineNumberForIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectImportViolations(file) {
  const content = readFileSync(file, "utf8");
  const patterns = [
    /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  ];

  const violations = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || isAllowedScriptImport(specifier)) {
        continue;
      }
      violations.push({
        line: lineNumberForIndex(content, match.index ?? 0),
        specifier,
      });
    }
  }

  return violations;
}

const allFiles = walk(builtinSkillDir);
const scriptFiles = allFiles.filter(
  (file) => toRepoPath(file).includes("/scripts/") && isScriptFile(file),
);
const forbiddenManifests = allFiles.filter((file) => {
  const repoPath = toRepoPath(file);
  const filename = repoPath.split("/").pop();
  return repoPath.includes("/scripts/") && forbiddenManifestNames.has(filename);
});

let violations = 0;

for (const file of scriptFiles.sort()) {
  for (const violation of collectImportViolations(file)) {
    if (violations === 0) {
      console.error("\n❌ Bundled skill script dependency violations found:\n");
    }
    console.error(`${toRepoPath(file)}:${violation.line}`);
    console.error(`  imports '${violation.specifier}'`);
    console.error(
      "  ↳ Bundled skill scripts must be self-contained: use relative files, Node/Bun built-ins, or document an explicit lazy resolver command.\n",
    );
    violations++;
  }
}

for (const file of forbiddenManifests.sort()) {
  if (violations === 0) {
    console.error("\n❌ Bundled skill script dependency violations found:\n");
  }
  console.error(toRepoPath(file));
  console.error(
    "  ↳ Do not rely on package manager manifests inside bundled skill scripts; scripts should run without a separate install step.\n",
  );
  violations++;
}

if (violations > 0) {
  console.error(
    `Found ${violations} bundled skill script dependency violation${violations === 1 ? "" : "s"}.`,
  );
  process.exit(1);
}

console.log("✅ Bundled skill scripts are self-contained.");
