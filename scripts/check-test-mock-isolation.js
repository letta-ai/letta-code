#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const TESTS_DIR_ENV = "LETTA_MOCK_ISOLATION_TESTS_DIR";

const rootDir = process.cwd();
const testsDir = process.env[TESTS_DIR_ENV]
  ? resolve(process.env[TESTS_DIR_ENV])
  : join(rootDir, "src", "tests");

const FORBIDDEN_MOCK_MODULES = new Map([
  [
    "/channels/config",
    "Use __testOverrideChannelsRoot() instead of replacing the shared channel config module.",
  ],
  [
    "/agent/context",
    "Use explicit env/context override seams instead of mocking the shared agent context module.",
  ],
  [
    "/runtime-context",
    "Use RuntimeContextSnapshot builders/overrides instead of mocking the shared runtime context module.",
  ],
  [
    "/settings-manager",
    "Use settings temp files or test override helpers instead of mocking the singleton settings manager.",
  ],
]);

const COMPLETE_EXPORT_MOCK_MODULES = new Set([
  "/channels/slack/runtime",
  "/channels/telegram/runtime",
  "/channels/discord/runtime",
]);

// Existing top-level module mocks that predate this guard. New top-level
// internal mocks are rejected by default because they are active while Bun loads
// other test files in the same process. Prefer dependency injection or an
// explicit test override helper. If a new top-level mock is truly unavoidable,
// add a file+module entry here in the same PR with a clear explanation.
const ALLOWED_TOP_LEVEL_MOCKS = new Set([
  "src/tests/channels/discord-registry.test.ts::../../backend/api/client",
  "src/tests/channels/slack-adapter-interop.test.ts::../../channels/slack/media",
  "src/tests/channels/slack-adapter-interop.test.ts::../../channels/slack/runtime",
  "src/tests/channels/slack-adapter.test.ts::../../channels/slack/media",
  "src/tests/channels/slack-adapter.test.ts::../../channels/slack/runtime",
  "src/tests/channels/telegram-adapter.test.ts::../../channels/telegram/runtime",
  "src/tests/cli/message-search-cache-warm.test.ts::../../backend/api/search",
  "src/tests/hooks/prompt-executor.test.ts::../../backend/api/generate",
  "src/tests/tools/memory-apply-patch.test.ts::../../backend/api/client",
  "src/tests/tools/memory-tool.test.ts::../../backend/api/client",
  "src/tests/tools/toolset-client-tool-rule-cleanup.test.ts::../../backend/api/client",
  "src/tests/tools/toolset-memfs-detach.test.ts::../../backend/api/client",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../agent/approval-execution",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../agent/approval-recovery",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../agent/message",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../backend/api/client",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../cli/helpers/approvalClassification",
  "src/tests/websocket/listen-client-concurrency.test.ts::../../cli/helpers/stream",
]);

const mockModulePattern = /\bmock\.module\s*\(\s*(["'`])([^"'`]+)\1/g;
const restoreHookPattern =
  /\bafter(?:All|Each)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]*?\bmock\.restore\s*\(/m;
const restoreHookFunctionPattern =
  /\bafter(?:All|Each)\s*\(\s*function\b[\s\S]*?\bmock\.restore\s*\(/m;

function collectTestFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeModuleSpecifier(moduleSpecifier) {
  return moduleSpecifier
    .replaceAll("\\", "/")
    .replace(/\.(?:ts|tsx|js|jsx)$/u, "");
}

function moduleMatches(moduleSpecifier, suffixes) {
  const normalized = normalizeModuleSpecifier(moduleSpecifier);
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix)) {
      return suffix;
    }
  }
  return null;
}

function isRelativeInternalModule(moduleSpecifier) {
  return moduleSpecifier.startsWith("../") || moduleSpecifier.startsWith("./");
}

function lineAndColumn(sourceText, index) {
  const before = sourceText.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function isTopLevelMockCall(sourceText, index) {
  const lineStart = sourceText.lastIndexOf("\n", index - 1) + 1;
  return lineStart === index;
}

function isLineCommentMatch(sourceText, index) {
  const lineStart = sourceText.lastIndexOf("\n", index - 1) + 1;
  const linePrefix = sourceText.slice(lineStart, index);
  return linePrefix.includes("//");
}

function isInsideQuotedText(sourceText, index) {
  let quote = null;
  let escaped = false;

  for (let i = 0; i < index; i += 1) {
    const char = sourceText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    }
  }

  return quote !== null;
}

function findMatchingParen(sourceText, openParenIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openParenIndex; i < sourceText.length; i += 1) {
    const char = sourceText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractMockCallText(sourceText, index) {
  const openParenIndex = sourceText.indexOf("(", index);
  if (openParenIndex === -1) {
    return "";
  }
  const closeParenIndex = findMatchingParen(sourceText, openParenIndex);
  if (closeParenIndex === -1) {
    return sourceText.slice(index);
  }
  return sourceText.slice(index, closeParenIndex + 1);
}

function resolveMockTargetPath(filePath, moduleSpecifier) {
  const basePath = resolve(dirname(filePath), moduleSpecifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
    join(basePath, "index.js"),
    join(basePath, "index.jsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getExportedNames(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const exportedNames = new Set();

  for (const match of sourceText.matchAll(
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) exportedNames.add(match[1]);
  }
  for (const match of sourceText.matchAll(
    /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) exportedNames.add(match[1]);
  }
  for (const match of sourceText.matchAll(/\bexport\s*{([^}]+)}/g)) {
    const specifiers = match[1]?.split(",") ?? [];
    for (const specifier of specifiers) {
      const cleaned = specifier.trim();
      if (!cleaned || cleaned.startsWith("type ")) continue;
      const aliasMatch = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const nameMatch = cleaned.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/);
      const exportedName = aliasMatch?.[1] ?? nameMatch?.[1];
      if (exportedName) exportedNames.add(exportedName);
    }
  }

  return exportedNames;
}

function getMockedObjectKeys(mockCallText) {
  const keys = new Set();
  const arrowObjectIndex = mockCallText.indexOf("=> ({");
  const objectStartIndex =
    arrowObjectIndex === -1
      ? mockCallText.indexOf("return {")
      : mockCallText.indexOf("{", arrowObjectIndex);
  if (objectStartIndex === -1) {
    return keys;
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let keyCandidate = "";
  let readingKey = false;

  for (let i = objectStartIndex; i < mockCallText.length; i += 1) {
    const char = mockCallText[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      readingKey = depth === 1;
      keyCandidate = "";
      continue;
    }
    if (char === "}") {
      depth -= 1;
      readingKey = depth === 1;
      keyCandidate = "";
      if (depth <= 0) break;
      continue;
    }

    if (depth !== 1) {
      continue;
    }

    if (char === ",") {
      readingKey = true;
      keyCandidate = "";
      continue;
    }

    if (!readingKey) {
      continue;
    }

    if (char === ":") {
      const key = keyCandidate.trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(key)) {
        keys.add(key);
      }
      readingKey = false;
      keyCandidate = "";
      continue;
    }

    keyCandidate += char;
  }

  return keys;
}

const failures = [];

for (const filePath of collectTestFiles(testsDir)) {
  const sourceText = readFileSync(filePath, "utf8");
  const mockedModules = Array.from(
    sourceText.matchAll(mockModulePattern),
  ).filter(
    (match) =>
      !isLineCommentMatch(sourceText, match.index ?? 0) &&
      !isInsideQuotedText(sourceText, match.index ?? 0),
  );

  if (mockedModules.length === 0) continue;

  const relativePath = relative(rootDir, filePath).replaceAll("\\", "/");
  const hasRestoreHook =
    restoreHookPattern.test(sourceText) ||
    restoreHookFunctionPattern.test(sourceText);
  if (!hasRestoreHook) {
    failures.push({
      type: "missing-restore",
      filePath: relativePath,
      mockedModules: mockedModules.map(
        (match) => match[2] ?? "<dynamic module>",
      ),
    });
  }

  for (const match of mockedModules) {
    const moduleSpecifier = match[2] ?? "<dynamic module>";
    const location = lineAndColumn(sourceText, match.index ?? 0);
    const forbiddenSuffix = moduleMatches(
      moduleSpecifier,
      FORBIDDEN_MOCK_MODULES.keys(),
    );
    if (forbiddenSuffix) {
      failures.push({
        type: "forbidden-module",
        filePath: relativePath,
        location,
        moduleSpecifier,
        reason: FORBIDDEN_MOCK_MODULES.get(forbiddenSuffix),
      });
    }

    if (
      isRelativeInternalModule(moduleSpecifier) &&
      isTopLevelMockCall(sourceText, match.index ?? 0)
    ) {
      const key = `${relativePath}::${moduleSpecifier}`;
      if (!ALLOWED_TOP_LEVEL_MOCKS.has(key)) {
        failures.push({
          type: "top-level-mock",
          filePath: relativePath,
          location,
          moduleSpecifier,
        });
      }
    }

    const completeMockSuffix = moduleMatches(
      moduleSpecifier,
      COMPLETE_EXPORT_MOCK_MODULES,
    );
    if (completeMockSuffix) {
      const targetPath = resolveMockTargetPath(filePath, moduleSpecifier);
      if (!targetPath) continue;

      const exportedNames = getExportedNames(targetPath);
      const mockCallText = extractMockCallText(sourceText, match.index ?? 0);
      const mockedKeys = getMockedObjectKeys(mockCallText);
      const missingExports = [...exportedNames].filter(
        (exportedName) => !mockedKeys.has(exportedName),
      );
      if (missingExports.length > 0) {
        failures.push({
          type: "partial-runtime-mock",
          filePath: relativePath,
          location,
          moduleSpecifier,
          missingExports,
        });
      }
    }
  }
}

if (failures.length > 0) {
  console.error("❌ Found unsafe Bun mock.module() usage.\n");

  for (const failure of failures) {
    switch (failure.type) {
      case "missing-restore":
        console.error(`- ${failure.filePath}`);
        console.error(
          "  missing: top-level afterEach/afterAll mock.restore() hook",
        );
        console.error(`  mocked modules: ${failure.mockedModules.join(", ")}`);
        break;
      case "forbidden-module":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  forbidden shared module mock: ${failure.moduleSpecifier}`,
        );
        console.error(`  ${failure.reason}`);
        break;
      case "top-level-mock":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  unsafe top-level internal module mock: ${failure.moduleSpecifier}`,
        );
        console.error(
          "  Top-level mock.module() calls are active while Bun loads other test files. Move the mock into the test/beforeEach, use dependency injection, or add an explicit test override helper.",
        );
        break;
      case "partial-runtime-mock":
        console.error(
          `- ${failure.filePath}:${failure.location.line}:${failure.location.column}`,
        );
        console.error(
          `  partial channel runtime mock: ${failure.moduleSpecifier}`,
        );
        console.error(
          `  missing exports: ${failure.missingExports.join(", ")}`,
        );
        console.error(
          "  Runtime module mocks must include every runtime export so later imports do not fail with missing ESM exports.",
        );
        break;
    }
  }

  console.error(
    "\nWhy this fails: Bun module mocks are process-global and can leak across files in the shared module cache.",
  );
  console.error(
    "Prefer explicit test override helpers or dependency injection. If a module mock is unavoidable, keep it scoped and restore it with afterEach().",
  );
  process.exit(1);
}

console.log("✅ No unsafe mock.module() usage found.");
