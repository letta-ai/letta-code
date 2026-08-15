#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Each top-level src directory owns its tests. A pull request runs a directory's
// tests when it changes that directory or a local file imported directly by it.
// The scan stops there on purpose: broad registration modules make a transitive
// import walk connect most of the repository, including unrelated channel tests
// for shell-only changes. Unknown paths and unresolved imports run every test.

const ROOT_FAMILY = "root";
const INTEGRATION_FAMILY = "integration-tests";
const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const SOURCE_FILE_PATTERN = /\.(?:c|m)?[jt]sx?$/u;
const LOCAL_IMPORT_PATTERN = /^(?:@\/|\.\.?\/)/u;

const NO_UNIT_TEST_PATHS = new Set([
  "AI_POLICY.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  ".github/pull_request_template.md",
  "assets/letta-code-demo.gif",
  "scripts/source-file-size-baseline.json",
]);

const FULL_UNIT_TEST_PATHS = new Set([
  ".github/workflows/ci.yml",
  "build.js",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "scripts/check-test-coverage.cjs",
  "scripts/isolated-unit-tests.json",
  "scripts/run-unit-tests.cjs",
  "scripts/unit-test-impact.cjs",
  "scripts/unit-test-impact.test.cjs",
  "tsconfig.json",
  "tsconfig.types.json",
]);

const NO_UNIT_TEST_PREFIXES = [
  ".github/ISSUE_TEMPLATE/",
  ".github/pr-assets/",
  "docs/",
];

const PATH_FAMILY_ANCHORS = [
  // These files are loaded through filesystem paths rather than imports.
  { path: "assets/tutor-profile.png", families: ["agent"] },
  { prefix: "docs/examples/mods/", families: ["cli", "mods"] },
  { prefix: "src/cli/app/", families: [ROOT_FAMILY] },
];

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function sourceFamily(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized.startsWith("src/")) return null;
  const relativePath = normalized.slice("src/".length);
  const slashIndex = relativePath.indexOf("/");
  return slashIndex === -1 ? ROOT_FAMILY : relativePath.slice(0, slashIndex);
}

function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(normalizePath(filePath));
}

function collectFiles(directory, predicate) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, predicate));
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function resolveExistingPath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.json`,
    `${basePath}.md`,
    `${basePath}.mdx`,
    `${basePath}.txt`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.jsx"),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function resolveLocalImport(params) {
  const { containingFile, moduleSpecifier, rootDir, compilerOptions, cache } =
    params;
  const resolved = ts.resolveModuleName(
    moduleSpecifier,
    containingFile,
    compilerOptions,
    ts.sys,
    cache,
  ).resolvedModule?.resolvedFileName;
  if (resolved) return resolved;

  const basePath = moduleSpecifier.startsWith("@/")
    ? path.join(rootDir, "src", moduleSpecifier.slice(2))
    : path.resolve(path.dirname(containingFile), moduleSpecifier);
  return resolveExistingPath(basePath) ?? null;
}

function collectAstReferences(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
  );
  const moduleSpecifiers = [];
  const fileReferences = [];
  const dynamicFileReaders = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.name ||
      !statement.body
    ) {
      continue;
    }
    const pathParameter = statement.parameters[0]?.name;
    if (!pathParameter || !ts.isIdentifier(pathParameter)) continue;
    let readsParameterFromModuleUrl = false;
    const findDynamicFileUrl = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" &&
        node.arguments?.[0] &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === pathParameter.text &&
        node.arguments?.[1]?.getText(sourceFile) === "import.meta.url"
      ) {
        readsParameterFromModuleUrl = true;
        return;
      }
      ts.forEachChild(node, findDynamicFileUrl);
    };
    findDynamicFileUrl(statement.body);
    if (readsParameterFromModuleUrl) {
      dynamicFileReaders.add(statement.name.text);
    }
  }

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "mock" &&
      node.expression.name.text === "module"
    ) {
      const moduleArgument = node.arguments[0];
      if (moduleArgument && ts.isStringLiteralLike(moduleArgument)) {
        moduleSpecifiers.push(moduleArgument.text);
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      const pathArgument = node.arguments?.[0];
      const baseArgument = node.arguments?.[1];
      if (
        pathArgument &&
        ts.isStringLiteralLike(pathArgument) &&
        baseArgument?.getText(sourceFile) === "import.meta.url"
      ) {
        fileReferences.push(pathArgument.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      dynamicFileReaders.has(node.expression.text)
    ) {
      const pathArgument = node.arguments[0];
      if (pathArgument && ts.isStringLiteralLike(pathArgument)) {
        fileReferences.push(pathArgument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { moduleSpecifiers, fileReferences };
}

function buildFamilyImpactIndex(rootDir = process.cwd()) {
  const sourceRoot = path.join(rootDir, "src");
  const configPath = path.join(rootDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(`Unable to read ${configPath}`);
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
  );
  const cache = ts.createModuleResolutionCache(
    rootDir,
    (fileName) => fileName,
    parsedConfig.options,
  );
  const familyDependencies = new Map();
  const fileDependencies = new Map();
  const unresolvedImports = [];
  const sourceFiles = collectFiles(sourceRoot, (filePath) =>
    SOURCE_FILE_PATTERN.test(filePath),
  );

  for (const absolutePath of sourceFiles) {
    const relativePath = normalizePath(path.relative(rootDir, absolutePath));
    const family = sourceFamily(relativePath);
    if (!family || family === INTEGRATION_FAMILY) continue;
    let dependencies = familyDependencies.get(family);
    if (!dependencies) {
      dependencies = new Set();
      familyDependencies.set(family, dependencies);
    }
    const directFileDependencies = new Set();
    fileDependencies.set(relativePath, directFileDependencies);

    const sourceText = readFileSync(absolutePath, "utf8");
    const preprocessed = ts.preProcessFile(sourceText, true, true);
    const moduleSpecifiers = new Set(
      preprocessed.importedFiles.map((entry) => entry.fileName),
    );
    let fileReferences = [];
    if (sourceText.includes("mock.module") || sourceText.includes("new URL(")) {
      const astReferences = collectAstReferences(sourceText, absolutePath);
      fileReferences = astReferences.fileReferences;
      for (const moduleSpecifier of astReferences.moduleSpecifiers) {
        moduleSpecifiers.add(moduleSpecifier);
      }
    }

    for (const moduleSpecifier of moduleSpecifiers) {
      if (!LOCAL_IMPORT_PATTERN.test(moduleSpecifier)) continue;
      const resolved = resolveLocalImport({
        containingFile: absolutePath,
        moduleSpecifier,
        rootDir,
        compilerOptions: parsedConfig.options,
        cache,
      });
      if (!resolved) {
        unresolvedImports.push({ file: relativePath, moduleSpecifier });
        continue;
      }
      const dependencyPath = normalizePath(path.relative(rootDir, resolved));
      if (dependencyPath.startsWith("../") || path.isAbsolute(dependencyPath)) {
        continue;
      }
      directFileDependencies.add(dependencyPath);
      if (sourceFamily(dependencyPath) !== family) {
        dependencies.add(dependencyPath);
      }
    }

    for (const fileReference of new Set(fileReferences)) {
      if (!LOCAL_IMPORT_PATTERN.test(fileReference)) continue;
      const basePath = path.resolve(path.dirname(absolutePath), fileReference);
      let resolvedPaths = [];
      try {
        const baseStat = statSync(basePath);
        if (baseStat.isDirectory()) {
          resolvedPaths = collectFiles(basePath, (filePath) =>
            SOURCE_FILE_PATTERN.test(filePath),
          );
        } else if (baseStat.isFile()) {
          resolvedPaths = [basePath];
        }
      } catch {
        const resolved = resolveLocalImport({
          containingFile: absolutePath,
          moduleSpecifier: fileReference,
          rootDir,
          compilerOptions: parsedConfig.options,
          cache,
        });
        if (resolved) resolvedPaths = [resolved];
      }
      for (const resolvedPath of resolvedPaths) {
        const dependencyPath = normalizePath(
          path.relative(rootDir, resolvedPath),
        );
        directFileDependencies.add(dependencyPath);
        if (sourceFamily(dependencyPath) !== family) {
          dependencies.add(dependencyPath);
        }
      }
    }
  }

  return { familyDependencies, fileDependencies, unresolvedImports };
}

function changedPath(change) {
  return normalizePath(change.path ?? change);
}

function fullRunReason(change) {
  const filePath = changedPath(change);
  const status = typeof change === "string" ? "M" : (change.status ?? "M");
  if (status.startsWith("R")) {
    const previousPath =
      typeof change === "string" || !change.previousPath
        ? null
        : normalizePath(change.previousPath);
    if (
      previousPath &&
      hasNoUnitTestImpact(previousPath) &&
      hasNoUnitTestImpact(filePath)
    ) {
      return null;
    }
    return `${previousPath ?? filePath} was renamed`;
  }
  if (status.startsWith("D")) {
    return hasNoUnitTestImpact(filePath) ? null : `${filePath} was deleted`;
  }
  if (hasNoUnitTestImpact(filePath)) return null;
  if (FULL_UNIT_TEST_PATHS.has(filePath)) {
    return `${filePath} can affect every unit test`;
  }
  if (filePath.startsWith("scripts/")) {
    return `${filePath} is unclassified test or build infrastructure`;
  }
  if (
    filePath.startsWith(".github/workflows/") ||
    filePath.startsWith("vendor/")
  ) {
    return `${filePath} is unclassified workflow or runtime infrastructure`;
  }
  return null;
}

function hasNoUnitTestImpact(filePath) {
  const normalized = normalizePath(filePath);
  return (
    NO_UNIT_TEST_PATHS.has(normalized) ||
    NO_UNIT_TEST_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function planUnitTests(params) {
  const { changedFiles, allTestFiles, impactIndex } = params;
  const normalizedTests = allTestFiles.map(normalizePath);
  const runAll = (reason) => ({
    mode: "full",
    reason,
    selectedFamilies: [],
    selectedTests: normalizedTests,
    omittedTests: [],
  });

  if (changedFiles.length === 0) {
    return runAll("no changed files were provided");
  }
  if (impactIndex.unresolvedImports.length > 0) {
    const first = impactIndex.unresolvedImports[0];
    return runAll(
      `local import ${first.file} -> ${first.moduleSpecifier} could not be resolved`,
    );
  }
  for (const change of changedFiles) {
    const reason = fullRunReason(change);
    if (reason) return runAll(reason);
  }

  const reasonsByFamily = new Map();
  const addFamily = (family, reason) => {
    if (!family || family === INTEGRATION_FAMILY) return;
    const reasons = reasonsByFamily.get(family) ?? new Set();
    reasons.add(reason);
    reasonsByFamily.set(family, reasons);
  };

  let sawSourceChange = false;
  for (const change of changedFiles) {
    const filePath = changedPath(change);
    const family = sourceFamily(filePath);
    if (family && family !== INTEGRATION_FAMILY) {
      sawSourceChange = true;
      addFamily(family, `${filePath} is owned by ${family}`);

      if (family === ROOT_FAMILY) {
        for (const dependency of impactIndex.fileDependencies?.get(filePath) ??
          []) {
          const dependencyFamily = sourceFamily(dependency);
          if (!dependencyFamily || dependencyFamily === ROOT_FAMILY) continue;
          addFamily(
            dependencyFamily,
            `${filePath} imports ${dependencyFamily} directly`,
          );
        }
      }
    }

    let anchoredFamilyFound = false;
    for (const anchor of PATH_FAMILY_ANCHORS) {
      const anchorPath = anchor.path ?? anchor.prefix;
      if (
        !anchorPath ||
        (anchor.path
          ? filePath !== anchor.path
          : !filePath.startsWith(anchorPath))
      ) {
        continue;
      }
      anchoredFamilyFound = true;
      sawSourceChange = true;
      for (const anchoredFamily of anchor.families) {
        addFamily(
          anchoredFamily,
          `${filePath} matches the ${anchorPath} test group`,
        );
      }
    }

    let directConsumerFound = false;
    for (const [
      consumerFamily,
      dependencies,
    ] of impactIndex.familyDependencies) {
      if (dependencies.has(filePath)) {
        directConsumerFound = true;
        sawSourceChange = true;
        addFamily(
          consumerFamily,
          `${consumerFamily} imports ${filePath} directly`,
        );
      }
    }

    if (family === INTEGRATION_FAMILY) continue;
    if (
      !family &&
      !directConsumerFound &&
      !anchoredFamilyFound &&
      !hasNoUnitTestImpact(filePath)
    ) {
      return runAll(`${filePath} is not classified for unit-test selection`);
    }
  }

  const selectedFamilies = [...reasonsByFamily.keys()].sort();
  const selectedFamilySet = new Set(selectedFamilies);
  const selectedTests = normalizedTests.filter((testPath) => {
    const family = sourceFamily(testPath);
    return family ? selectedFamilySet.has(family) : false;
  });

  if (sawSourceChange && selectedTests.length === 0) {
    return runAll("source changes selected no unit tests");
  }

  const selectedTestSet = new Set(selectedTests);
  return {
    mode: "selected",
    reason:
      selectedTests.length === 0
        ? "changed files do not affect unit tests"
        : `selected ${selectedFamilies.join(", ")}`,
    selectedFamilies: selectedFamilies.map((family) => ({
      family,
      reasons: [...(reasonsByFamily.get(family) ?? [])].sort(),
    })),
    selectedTests,
    omittedTests: normalizedTests.filter((test) => !selectedTestSet.has(test)),
  };
}

function getGitChangedFiles(baseSha, headSha, rootDir = process.cwd()) {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "--find-renames",
      "--diff-filter=ACDMRTUXB",
      baseSha,
      headSha,
    ],
    { cwd: rootDir, encoding: "utf8" },
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split("\t");
      return {
        status,
        path: normalizePath(secondPath ?? firstPath),
        previousPath: secondPath ? normalizePath(firstPath) : undefined,
      };
    });
}

function readPullRequestShas(eventPath) {
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const baseSha = event.pull_request?.base?.sha;
  const headSha =
    event.pull_request?.merge_commit_sha ?? event.pull_request?.head?.sha;
  if (typeof baseSha !== "string" || typeof headSha !== "string") {
    throw new Error("Pull request event is missing base/head SHAs");
  }
  return { baseSha, headSha };
}

module.exports = {
  ROOT_FAMILY,
  buildFamilyImpactIndex,
  getGitChangedFiles,
  isTestFile,
  normalizePath,
  planUnitTests,
  readPullRequestShas,
  sourceFamily,
};

if (require.main === module) {
  const baseIndex = process.argv.indexOf("--base");
  const headIndex = process.argv.indexOf("--head");
  if (baseIndex === -1 || headIndex === -1) {
    console.error("Usage: unit-test-impact.cjs --base <sha> --head <sha>");
    process.exit(2);
  }
  const rootDir = process.cwd();
  const changedFiles = getGitChangedFiles(
    process.argv[baseIndex + 1],
    process.argv[headIndex + 1],
    rootDir,
  );
  const allTestFiles = collectFiles(path.join(rootDir, "src"), (filePath) =>
    isTestFile(filePath),
  )
    .map((filePath) => normalizePath(path.relative(rootDir, filePath)))
    .filter((filePath) => sourceFamily(filePath) !== INTEGRATION_FAMILY)
    .concat("scripts/unit-test-impact.test.cjs")
    .sort();
  const plan = planUnitTests({
    changedFiles,
    allTestFiles,
    impactIndex: buildFamilyImpactIndex(rootDir),
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
