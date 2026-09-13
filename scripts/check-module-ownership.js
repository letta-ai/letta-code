#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const RULES = [
  {
    module: "src/channels/slack/adapter.ts",
    allowedImporters: new Set([
      "src/channels/slack/adapter-test-harness.ts",
      "src/channels/slack/plugin.ts",
    ]),
    forbidForwardingExports: true,
  },
];

function findTypeScriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTypeScriptFiles(filePath));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(filePath.replace(/\\/g, "/"));
    }
  }
  return files;
}

function resolveModule(importer, specifier) {
  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = path.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidate = path.join(path.dirname(importer), specifier);
  } else {
    return null;
  }

  const normalized = path.normalize(candidate).replace(/\\/g, "/");
  const candidates = [normalized, `${normalized}.ts`, `${normalized}.tsx`];
  return candidates.find((item) => ruleModules.has(item)) ?? null;
}

function parseTypeScript(filePath, source) {
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const rulesByModule = new Map(RULES.map((rule) => [rule.module, rule]));
const ruleModules = new Set(rulesByModule.keys());
const files = findTypeScriptFiles("src");
const failures = [];

for (const importer of files) {
  const source = readFileSync(importer, "utf8");
  const sourceFile = parseTypeScript(importer, source);
  for (const specifier of collectModuleSpecifiers(sourceFile)) {
    const module = resolveModule(importer, specifier);
    if (!module) continue;
    const rule = rulesByModule.get(module);
    if (importer !== module && !rule.allowedImporters.has(importer)) {
      failures.push(
        `${importer}: import ${specifier} from its owning module instead of ${module}`,
      );
    }
  }
}

for (const rule of RULES) {
  if (!rule.forbidForwardingExports) continue;
  const source = readFileSync(rule.module, "utf8");
  const sourceFile = parseTypeScript(rule.module, source);
  const hasForwardingExport = sourceFile.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) && statement.moduleSpecifier,
  );
  if (hasForwardingExport) {
    failures.push(
      `${rule.module}: forwarding exports hide module ownership; import from the defining module`,
    );
  }
}

if (failures.length > 0) {
  console.error("Module ownership check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`Checked ${files.length} TypeScript files for module ownership`);
