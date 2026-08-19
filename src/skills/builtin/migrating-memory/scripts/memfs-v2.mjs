#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateAgent,
  agentHasMemfsV2Tag,
  normalizeBackend,
  preflightAgent,
  revertConversion,
} from "./target-activation.mjs";
import {
  assertNoIgnoredTargetFiles,
  describeTargetChanges,
} from "./target-review.mjs";

const TODO_DESCRIPTION = "TODO: Describe when this memory should be loaded.";
const GENERATED_INDEX_NOTE =
  "TODO: Replace this generated index with a short overview and relative links.";
const IGNORED_ROOT_ENTRIES = new Set([".git", ".letta", ".DS_Store"]);

function fail(message) {
  throw new Error(message);
}

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function portablePathKey(relativePath) {
  return relativePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function listCommittedFiles(memoryDir) {
  const output = git(memoryDir, ["ls-tree", "-rz", "--full-tree", "HEAD"]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) fail(`Unexpected git ls-tree record: ${record}`);
      const [mode, type, object] = record.slice(0, separator).split(" ");
      const relativePath = record.slice(separator + 1);
      if (type !== "blob" || mode === "120000") {
        fail(`Unsupported committed entry: ${relativePath} (${type} ${mode})`);
      }
      return { relativePath, mode, object };
    });
}

function readCommittedBlob(memoryDir, object) {
  return git(memoryDir, ["cat-file", "blob", object], { encoding: null });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return { command, values };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(target, label) {
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) fail(`${label} is not a directory: ${target}`);
}

async function assertNoSymlink(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${target}`);
}

async function walkFiles(root, options = {}) {
  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!relativeDirectory && options.ignoreRootEntries?.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalize(path.join(relativeDirectory, entry.name));
      await assertNoSymlink(fullPath, root);
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        fail(`Unsupported filesystem entry: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return files;
}

function isSkillPath(relativePath) {
  return relativePath === "skills" || relativePath.startsWith("skills/");
}

function isMarkdown(relativePath) {
  return relativePath.toLowerCase().endsWith(".md");
}

function isMemoryIndex(relativePath) {
  return path.posix.basename(relativePath) === "MEMORY.md";
}

function destinationForSource(relativePath) {
  if (!relativePath.startsWith("system/")) return relativePath;
  const segments = relativePath.slice("system/".length).split("/");
  return segments.join("-");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseFrontmatter(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, entries: [], hasFrontmatter: false };
  }
  let end = normalized.indexOf("\n---\n", 4);
  let delimiterLength = "\n---\n".length;
  if (end < 0 && normalized.endsWith("\n---")) {
    end = normalized.length - "\n---".length;
    delimiterLength = "\n---".length;
  }
  if (end < 0) fail("Unclosed Markdown frontmatter");
  const header = normalized.slice(4, end);
  const entries = [];
  for (const line of header.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      const marker = match[2].trim();
      const blockStyle = /^[|>][-+]?$/.test(marker) ? marker.charAt(0) : null;
      entries.push([match[1], blockStyle ? "" : unquote(match[2]), blockStyle]);
      continue;
    }
    if (/^\s+/.test(line) && entries.length > 0) {
      const current = entries.at(-1);
      const separator = current[2] === "|" ? "\n" : " ";
      current[1] = `${current[1]}${current[1] ? separator : ""}${line.trim()}`;
      continue;
    }
    fail(`Unsupported frontmatter line: ${line}`);
  }
  return {
    body: normalized.slice(end + delimiterLength),
    entries: entries.map(([key, value]) => [key, value]),
    hasFrontmatter: true,
  };
}

function readableName(relativePath) {
  const stem = path.posix.basename(
    relativePath,
    path.posix.extname(relativePath),
  );
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function yamlScalar(value) {
  return JSON.stringify(value.replaceAll("\r\n", "\n").trim());
}

function mappedLinkTarget(target, sourcePath, destinationPath, pathMap) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
    return null;
  }
  const fragmentIndex = target.search(/[?#]/);
  const pathname = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
  const fragment = fragmentIndex >= 0 ? target.slice(fragmentIndex) : "";
  const rootRelative = normalize(path.posix.normalize(pathname));
  const resolvedSource = pathMap.has(rootRelative)
    ? rootRelative
    : normalize(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(sourcePath), pathname),
        ),
      );
  const mapped = pathMap.get(resolvedSource);
  if (!mapped) return null;
  let nextTarget = path.posix.relative(
    path.posix.dirname(destinationPath),
    mapped,
  );
  if (!nextTarget) nextTarget = path.posix.basename(mapped);
  return `${nextTarget}${fragment}`;
}

function rewriteKnownLinks(body, sourcePath, destinationPath, pathMap) {
  const inline = body.replace(
    /\]\(([^)\s]+)([^)]*)\)/g,
    (full, target, suffix) => {
      const mapped = mappedLinkTarget(
        target,
        sourcePath,
        destinationPath,
        pathMap,
      );
      return mapped ? `](${mapped}${suffix})` : full;
    },
  );
  const wiki = inline.replace(
    /`?\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]`?/g,
    (full, target, fragment = "", alias) => {
      const mapped = mappedLinkTarget(
        `${target}${fragment}`,
        sourcePath,
        destinationPath,
        pathMap,
      );
      if (!mapped) return full;
      const label =
        alias ?? path.posix.basename(target, path.posix.extname(target));
      return `[${label}](${mapped})`;
    },
  );
  return wiki.replace(
    /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/gm,
    (full, prefix, target, suffix) => {
      const mapped = mappedLinkTarget(
        target,
        sourcePath,
        destinationPath,
        pathMap,
      );
      return mapped ? `${prefix}${mapped}${suffix}` : full;
    },
  );
}

function rewrittenMemoryMarkdown(
  content,
  sourcePath,
  destinationPath,
  pathMap,
) {
  const parsed = parseFrontmatter(content);
  const metadata = new Map(parsed.entries);
  const name = metadata.get("name") || readableName(destinationPath);
  const description = metadata.get("description") || TODO_DESCRIPTION;
  const body = rewriteKnownLinks(
    parsed.body,
    sourcePath,
    destinationPath,
    pathMap,
  ).replace(/^\n+/, "");
  return {
    content: [
      "---",
      `name: ${yamlScalar(name)}`,
      `description: ${yamlScalar(description)}`,
      "---",
      body,
    ].join("\n"),
    missingName: !metadata.get("name"),
    missingDescription: !metadata.get("description"),
  };
}

function rewrittenMemoryIndex(content, sourcePath, destinationPath, pathMap) {
  const parsed = parseFrontmatter(content);
  const body = rewriteKnownLinks(
    parsed.body,
    sourcePath,
    destinationPath,
    pathMap,
  ).replace(/^\n+/, "");
  return body || generatedIndex(destinationPath);
}

function generatedIndex(relativePath) {
  const directory = path.posix.dirname(relativePath);
  const heading = directory === "." ? "Memory" : readableName(directory);
  return `# ${heading}\n\n${GENERATED_INDEX_NOTE}\n`;
}

function resolvedLocalLink(target, indexPath, files) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
    return null;
  }
  const pathname = target.split(/[?#]/, 1)[0];
  let resolved = normalize(
    path.posix.normalize(
      path.posix.join(path.posix.dirname(indexPath), pathname),
    ),
  );
  if (resolved.endsWith("/")) resolved = `${resolved}MEMORY.md`;
  return files.has(resolved) ? resolved : null;
}

function hasLocalIndexLink(body, indexPath, files) {
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    if (resolvedLocalLink(match[1], indexPath, files)) return true;
  }
  return false;
}

function indexRoutingNotes(body, indexPath, files) {
  const notes = [];
  for (const match of body.matchAll(
    /^\s*[-*]\s+\[[^\]]+\]\(([^)\s]+)(?:\s+[^)]*)?\)\s+-\s+(.+?)\s*$/gm,
  )) {
    const relativePath = resolvedLocalLink(match[1], indexPath, files);
    if (relativePath) notes.push({ relativePath, summary: match[2] });
  }
  return notes;
}

function comparableDescription(value) {
  return value
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function parentDirectories(relativePath) {
  const directories = [];
  let current = path.posix.dirname(relativePath);
  while (current !== ".") {
    directories.push(current);
    current = path.posix.dirname(current);
  }
  directories.push("");
  return directories;
}

async function copyWithMode(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const sourceInfo = await stat(source);
  await chmod(destination, sourceInfo.mode);
}

async function writeCommittedFile(destination, content, mode) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
  await chmod(destination, mode === "100755" ? 0o755 : 0o644);
}

async function stageTree(source, target, output) {
  await assertDirectory(source, "Source");
  await assertDirectory(target, "Target");
  if (await exists(output)) fail(`Output already exists: ${output}`);
  const sourceReal = await realpath(source);
  const targetReal = await realpath(target);
  if (
    sourceReal !== targetReal &&
    (sourceReal.startsWith(`${targetReal}${path.sep}`) ||
      targetReal.startsWith(`${sourceReal}${path.sep}`))
  ) {
    fail("Source and target repositories must not contain one another");
  }
  assertNoIgnoredTargetFiles(targetReal);
  const outputParent = await realpath(path.dirname(output));
  const outputResolved = path.join(outputParent, path.basename(output));
  const manifestPath = `${outputResolved}.manifest.json`;
  if (await exists(manifestPath))
    fail(`Manifest already exists: ${manifestPath}`);
  for (const [label, directory] of [
    ["source", sourceReal],
    ["target", targetReal],
  ]) {
    if (
      outputResolved === directory ||
      outputResolved.startsWith(`${directory}${path.sep}`)
    ) {
      fail(`Output must be outside the ${label} memory directory`);
    }
  }

  const files = listCommittedFiles(sourceReal).filter(
    (file) =>
      !IGNORED_ROOT_ENTRIES.has(file.relativePath.split("/").at(0) ?? ""),
  );
  const sourceBlobs = new Map(
    files.map((file) => [
      file.relativePath,
      readCommittedBlob(sourceReal, file.object),
    ]),
  );
  const pathMap = new Map();
  const destinationSources = new Map();
  const portableDestinations = new Map();
  for (const file of files) {
    const sourcePath = file.relativePath;
    const destinationPath = destinationForSource(sourcePath);
    const collision = destinationSources.get(destinationPath);
    const portableCollision = portableDestinations.get(
      portablePathKey(destinationPath),
    );
    if (collision || portableCollision) {
      fail(
        `Destination collision: ${collision?.relativePath ?? portableCollision.sourcePath} and ${sourcePath} map to ${portableCollision?.destinationPath ?? destinationPath}`,
      );
    }
    pathMap.set(sourcePath, destinationPath);
    destinationSources.set(destinationPath, file);
    portableDestinations.set(portablePathKey(destinationPath), {
      sourcePath,
      destinationPath,
    });
  }

  const memoryDirectories = new Set([""]);
  for (const destinationPath of pathMap.values()) {
    if (isMarkdown(destinationPath) && !isSkillPath(destinationPath)) {
      for (const directory of parentDirectories(destinationPath)) {
        memoryDirectories.add(directory);
      }
    }
  }
  const generatedIndexes = [];
  for (const directory of [...memoryDirectories].sort()) {
    const indexPath = directory ? `${directory}/MEMORY.md` : "MEMORY.md";
    if (!destinationSources.has(indexPath)) {
      const collision = portableDestinations.get(portablePathKey(indexPath));
      if (collision) {
        fail(
          `Destination collision: generated ${indexPath} conflicts with ${collision.sourcePath}`,
        );
      }
      destinationSources.set(indexPath, null);
      portableDestinations.set(portablePathKey(indexPath), {
        sourcePath: "<generated>",
        destinationPath: indexPath,
      });
      generatedIndexes.push(indexPath);
    }
  }

  const todoDescriptions = [];
  const derivedNames = [];
  const flattened = [];
  await mkdir(outputResolved, { recursive: false });
  for (const [destinationPath, sourceFile] of [...destinationSources].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const destination = path.join(outputResolved, destinationPath);
    if (sourceFile === null) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, generatedIndex(destinationPath), "utf8");
      continue;
    }
    const sourcePath = sourceFile.relativePath;
    const sourceContent = sourceBlobs.get(sourcePath);
    if (!sourceContent) fail(`Missing committed blob for ${sourcePath}`);
    if (sourcePath !== destinationPath) {
      flattened.push({ from: sourcePath, to: destinationPath });
    }
    if (!isMarkdown(destinationPath) || isSkillPath(destinationPath)) {
      await writeCommittedFile(destination, sourceContent, sourceFile.mode);
      continue;
    }
    const content = sourceContent.toString("utf8");
    await mkdir(path.dirname(destination), { recursive: true });
    if (isMemoryIndex(destinationPath)) {
      await writeFile(
        destination,
        rewrittenMemoryIndex(content, sourcePath, destinationPath, pathMap),
        "utf8",
      );
      continue;
    }
    const rewritten = rewrittenMemoryMarkdown(
      content,
      sourcePath,
      destinationPath,
      pathMap,
    );
    if (rewritten.missingName) derivedNames.push(destinationPath);
    if (rewritten.missingDescription) todoDescriptions.push(destinationPath);
    await writeFile(destination, rewritten.content, "utf8");
  }

  const validation = await validateTree(outputResolved, {
    allowPlaceholders: true,
  });
  const targetChanges = await describeTargetChanges(targetReal, outputResolved);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        source: sourceReal,
        source_head: git(sourceReal, ["rev-parse", "HEAD"]).trim(),
        target: targetReal,
        target_head: git(targetReal, ["rev-parse", "HEAD"]).trim(),
        skills: files
          .filter((file) => isSkillPath(file.relativePath))
          .map((file) => ({
            path: file.relativePath,
            sha256: sha256(sourceBlobs.get(file.relativePath)),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    source: sourceReal,
    target: targetReal,
    output: outputResolved,
    manifest: manifestPath,
    flattened,
    generated_indexes: generatedIndexes,
    derived_names: derivedNames,
    todo_descriptions: todoDescriptions,
    target_changes: targetChanges,
    validation,
  };
}

async function validateTree(source, options = {}) {
  await assertDirectory(source, "Prepared tree");
  for (const forbidden of [".git", ".letta"]) {
    if (await exists(path.join(source, forbidden))) {
      fail(`Prepared tree must not contain ${forbidden}`);
    }
  }
  const files = await walkFiles(source);
  const fileSet = new Set(files);
  const hasIndexedContent = files.some(
    (file) => isMarkdown(file) && !isSkillPath(file) && !isMemoryIndex(file),
  );
  const memoryDescriptions = new Map();
  for (const relativePath of files) {
    if (
      !isMarkdown(relativePath) ||
      isSkillPath(relativePath) ||
      isMemoryIndex(relativePath)
    ) {
      continue;
    }
    const content = await readFile(path.join(source, relativePath), "utf8");
    const metadata = new Map(parseFrontmatter(content).entries);
    const description = metadata.get("description")?.trim();
    if (description) memoryDescriptions.set(relativePath, description);
  }
  if (!files.includes("MEMORY.md")) {
    fail("Prepared tree is missing root MEMORY.md");
  }
  const markdownDirectories = new Set();
  for (const relativePath of files) {
    if (!isMarkdown(relativePath) || isSkillPath(relativePath)) continue;
    for (const directory of parentDirectories(relativePath)) {
      if (directory) markdownDirectories.add(directory);
    }
    const content = await readFile(path.join(source, relativePath), "utf8");
    const parsed = parseFrontmatter(content);
    if (isMemoryIndex(relativePath)) {
      if (parsed.hasFrontmatter) {
        fail(`${relativePath} must not have frontmatter`);
      }
      if (
        !options.allowPlaceholders &&
        parsed.body.includes(GENERATED_INDEX_NOTE)
      ) {
        fail(`${relativePath} still contains the generated index placeholder`);
      }
      if (
        !options.allowPlaceholders &&
        hasIndexedContent &&
        !hasLocalIndexLink(parsed.body, relativePath, fileSet)
      ) {
        fail(`${relativePath} must link to at least one local memory file`);
      }
      if (!options.allowPlaceholders) {
        for (const note of indexRoutingNotes(
          parsed.body,
          relativePath,
          fileSet,
        )) {
          const description = memoryDescriptions.get(note.relativePath);
          if (
            description &&
            comparableDescription(note.summary) ===
              comparableDescription(description)
          ) {
            fail(
              `${relativePath} routing note for ${note.relativePath} duplicates its frontmatter description; replace it with a shorter reason to open the file`,
            );
          }
        }
      }
      continue;
    }
    const keys = parsed.entries.map(([key]) => key).sort();
    if (keys.join(",") !== "description,name") {
      fail(
        `${relativePath} must have exactly name and description frontmatter`,
      );
    }
    const metadata = new Map(parsed.entries);
    if (!metadata.get("name")?.trim() || !metadata.get("description")?.trim()) {
      fail(`${relativePath} has empty name or description frontmatter`);
    }
    if (
      !options.allowPlaceholders &&
      metadata.get("description") === TODO_DESCRIPTION
    ) {
      fail(
        `${relativePath} still contains the generated description placeholder`,
      );
    }
  }
  for (const directory of markdownDirectories) {
    const indexPath = `${directory}/MEMORY.md`;
    if (!files.includes(indexPath)) {
      fail(`${directory} contains memory Markdown but has no MEMORY.md`);
    }
  }
  return {
    files: files.length,
    markdown_files: files.filter(
      (file) => isMarkdown(file) && !isSkillPath(file),
    ).length,
  };
}

function git(memoryDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
}

async function assertCleanGitTree(memoryDir) {
  git(memoryDir, ["rev-parse", "--git-dir"]);
  const requestedRoot = await realpath(memoryDir);
  const gitRoot = await realpath(
    git(memoryDir, ["rev-parse", "--show-toplevel"]).trim(),
  );
  if (requestedRoot !== gitRoot) {
    fail(`Memory directory must be the Git worktree root: ${gitRoot}`);
  }
  const statusOutput = git(memoryDir, [
    "-c",
    "status.renames=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).trim();
  if (statusOutput) fail("Memory repository has uncommitted changes");
}

async function removeTreeContents(root, preserve = new Set()) {
  for (const entry of await readdir(root)) {
    if (preserve.has(entry)) continue;
    await rm(path.join(root, entry), { recursive: true, force: true });
  }
}

async function copyTreeContents(source, destination, options = {}) {
  for (const relativePath of await walkFiles(source, options)) {
    await copyWithMode(
      path.join(source, relativePath),
      path.join(destination, relativePath),
    );
  }
}

async function preparedSkillsManifest(source) {
  const skillsRoot = path.join(source, "skills");
  if (!(await exists(skillsRoot))) return [];
  const files = await walkFiles(skillsRoot);
  const manifest = await Promise.all(
    files.map(async (relativePath) => ({
      path: `skills/${relativePath}`,
      sha256: sha256(await readFile(path.join(skillsRoot, relativePath))),
    })),
  );
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

function nullSeparatedGitPaths(memoryDir, args) {
  return git(memoryDir, args).split("\0").filter(Boolean);
}

function forPathChunks(paths, run) {
  for (let index = 0; index < paths.length; index += 200) {
    run(paths.slice(index, index + 200));
  }
}

function gitIdentityEnvironment() {
  const authorId = process.env.AGENT_ID?.trim() || "letta-agent";
  const authorName = process.env.AGENT_NAME?.trim() || authorId;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: `${authorId}@letta.com`,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: `${authorId}@letta.com`,
  };
}

async function prepareApply(prepared, target) {
  const preparedReal = await realpath(prepared);
  const targetReal = await realpath(target);
  if (
    preparedReal === targetReal ||
    preparedReal.startsWith(`${targetReal}${path.sep}`) ||
    targetReal.startsWith(`${preparedReal}${path.sep}`)
  ) {
    fail("Prepared tree and target repository must not contain one another");
  }
  const manifestPath = `${preparedReal}.manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestSource = await realpath(manifest.source).catch(() => null);
  if (!manifestSource || manifestSource !== manifest.source) {
    fail("Source repository from the staged review is unavailable");
  }
  await assertCleanGitTree(manifestSource);
  if (
    manifest.source_head !== git(manifestSource, ["rev-parse", "HEAD"]).trim()
  ) {
    fail("Source repository changed after the review tree was staged");
  }
  if (manifest.target !== targetReal) {
    fail("Prepared tree was staged for a different target repository");
  }
  if (manifest.target_head !== git(targetReal, ["rev-parse", "HEAD"]).trim()) {
    fail("Target repository changed after the review tree was staged");
  }
  const expectedSkills = JSON.stringify(manifest.skills ?? []);
  const preparedSkills = JSON.stringify(
    await preparedSkillsManifest(preparedReal),
  );
  if (preparedSkills !== expectedSkills) {
    fail("Prepared skills differ from the committed source skills");
  }
  const validation = await validateTree(preparedReal);
  await assertCleanGitTree(targetReal);
  assertNoIgnoredTargetFiles(targetReal);
  const targetChanges = await describeTargetChanges(targetReal, preparedReal);
  return { preparedReal, targetReal, targetChanges, validation };
}

async function commitPreparedTree(preparation) {
  const { preparedReal, targetReal, targetChanges, validation } = preparation;
  const backup = await mkdtemp(path.join(tmpdir(), "memfs-v2-backup-"));
  await copyTreeContents(targetReal, backup, {
    ignoreRootEntries: new Set([".git", ".letta"]),
  });
  let committed = false;
  try {
    await removeTreeContents(targetReal, new Set([".git", ".letta"]));
    await copyTreeContents(preparedReal, targetReal);
    const preparedPaths = await walkFiles(preparedReal);
    const trackedPaths = nullSeparatedGitPaths(targetReal, ["ls-files", "-z"]);
    forPathChunks(preparedPaths, (paths) =>
      git(targetReal, ["add", "-f", "--", ...paths]),
    );
    forPathChunks(trackedPaths, (paths) =>
      git(targetReal, ["add", "-u", "--", ...paths]),
    );
    const paths = nullSeparatedGitPaths(targetReal, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    if (paths.length === 0) fail("Prepared tree produces no changes");
    git(targetReal, ["commit", "-m", "migrate memory filesystem to v2"], {
      env: gitIdentityEnvironment(),
    });
    committed = true;
    return {
      target_dir: targetReal,
      commit: git(targetReal, ["rev-parse", "HEAD"]).trim(),
      changed_paths: paths,
      target_changes: targetChanges,
      validation,
    };
  } catch (error) {
    if (!committed) {
      await removeTreeContents(targetReal, new Set([".git", ".letta"]));
      await copyTreeContents(backup, targetReal);
      git(targetReal, ["reset", "--mixed", "HEAD"]);
    }
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function validateReview(prepared) {
  const preparedReal = await realpath(prepared);
  const manifest = JSON.parse(
    await readFile(`${preparedReal}.manifest.json`, "utf8"),
  );
  const preparation = await prepareApply(preparedReal, manifest.target);
  return {
    ...preparation.validation,
    target_changes: preparation.targetChanges,
  };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "stage") {
    if (!values.source || !values.target || !values.output) {
      fail("stage requires --source, --target, and --output");
    }
    await assertCleanGitTree(path.resolve(values.source));
    await assertCleanGitTree(path.resolve(values.target));
    printJson(
      await stageTree(
        path.resolve(values.source),
        path.resolve(values.target),
        path.resolve(values.output),
      ),
    );
    return;
  }
  if (command === "validate") {
    if (!values.prepared) fail("validate requires --prepared");
    printJson(await validateReview(path.resolve(values.prepared)));
    return;
  }
  if (command === "apply") {
    if (
      !values.prepared ||
      !values.target ||
      !values["target-agent"] ||
      !values["target-backend"]
    ) {
      fail(
        "apply requires --prepared, --target, --target-agent, and --target-backend",
      );
    }
    const targetBackend = normalizeBackend(values["target-backend"]);
    const initialPreparation = await prepareApply(
      path.resolve(values.prepared),
      path.resolve(values.target),
    );
    preflightAgent(
      targetBackend,
      values["target-agent"],
      initialPreparation.targetReal,
    );
    const preparation = await prepareApply(
      path.resolve(values.prepared),
      path.resolve(values.target),
    );
    const result = await commitPreparedTree(preparation);
    try {
      printJson({
        ...result,
        activation: activateAgent(
          targetBackend,
          values["target-agent"],
          result.target_dir,
          result.commit,
        ),
      });
    } catch (error) {
      const tagged =
        targetBackend === "local"
          ? await agentHasMemfsV2Tag(result.target_dir, values["target-agent"])
          : null;
      if (tagged === false) {
        revertConversion(result.target_dir, result.commit);
        fail(
          `Activation failed and the conversion commit was reverted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      fail(
        `Activation failed after the conversion commit. Tag status could not be safely rolled back; inspect the agent before retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  fail("Usage: memfs-v2.mjs <stage|validate|apply> [options]");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
