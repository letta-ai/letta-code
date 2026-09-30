/**
 * Memory() tool: progressive discovery of deferred MemFS v2 memory.
 *
 * Root memory files are already in the system prompt; everything beneath the
 * root is deferred. Reading a directory returns its MEMORY.md plus the files
 * and subdirectories directly beneath it; reading a file returns the file.
 * Output limits mirror Read.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, join, sep } from "node:path";
import { getCurrentAgentId } from "@/agent/context";
import { detectMemoryFormat } from "@/agent/memory-format";
import { getActiveMemoryDirectory } from "@/agent/memory-runtime";
import { parseFrontmatter } from "@/utils/frontmatter";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const INDEX = "MEMORY.md";

interface MemoryArgs {
  path: string;
}

/**
 * The agent's memory directory when it uses the MemFS v2 layout (MemFS active
 * and a root MEMORY.md), otherwise null. Gates both toolset inclusion and
 * execution.
 */
export function resolveMemoryToolDirectory(
  agentId?: string | null,
): string | null {
  try {
    // null means an agentless conversation; only undefined falls back to scope.
    const id = agentId === undefined ? getCurrentAgentId() : agentId;
    const memoryDir = id ? getActiveMemoryDirectory(id) : undefined;
    return memoryDir && detectMemoryFormat(memoryDir, false) === "memfs-v2"
      ? memoryDir
      : null;
  } catch {
    return null;
  }
}

function readDescription(path: string): string | undefined {
  try {
    const value = parseFrontmatter(readFileSync(path, "utf8")).frontmatter
      .description;
    return typeof value === "string" ? value.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Child MEMORY.md indexes are frontmatter-free in MemFS v2, so fall back to the
 * index's first prose paragraph (after any frontmatter and headings).
 */
function readIndexDescription(path: string): string | undefined {
  const fromFrontmatter = readDescription(path);
  if (fromFrontmatter) return fromFrontmatter;
  try {
    const { body } = parseFrontmatter(readFileSync(path, "utf8"));
    for (const block of body.split(/\n\s*\n/)) {
      const text = block.trim();
      if (!text || /^(#|[-*+] |\d+\. |\||```|<)/.test(text)) continue;
      const paragraph = text
        .replace(/\s*\n\s*/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      return paragraph.length > 300
        ? `${paragraph.slice(0, 297)}...`
        : paragraph;
    }
  } catch {
    // No readable index.
  }
  return undefined;
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** Memory-root-relative paths of non-root files with this basename. */
function findByBasename(
  dir: string,
  name: string,
  root = dir,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= 5) break;
    if (isHidden(entry.name) || (dir === root && entry.name === "skills")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findByBasename(path, name, root, found);
    else if (entry.isFile() && entry.name === name && dir !== root) {
      found.push(
        path
          .slice(root.length + 1)
          .split(sep)
          .join("/"),
      );
    }
  }
  return found;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function descriptionAttr(description: string | undefined): string {
  return description
    ? ` description="${escapeXmlText(description).replace(/"/g, "&quot;")}"`
    : "";
}

/** Read's line, per-line, and total-character limits; notices in Read's order. */
function clampContent(
  content: string,
  fullPath: string,
  maxChars: number,
): string {
  const lines = content.split("\n");
  const shown = lines.slice(0, LIMITS.READ_MAX_LINES);
  let longLines = false;
  let result = shown
    .map((line) => {
      if (line.length <= LIMITS.READ_MAX_CHARS_PER_LINE) return line;
      longLines = true;
      return `${line.slice(0, LIMITS.READ_MAX_CHARS_PER_LINE)}... [line truncated]`;
    })
    .join("\n");

  const byTotal = result.length > maxChars;
  if (byTotal) result = truncateByChars(result, maxChars, "Memory").content;

  const byLines = shown.length < lines.length;
  const notices: string[] = [];
  if (byLines) {
    notices.push(
      `[File truncated: showing lines 1-${shown.length} of ${lines.length} total lines. Use Read with offset and limit on the full file to read other sections.]`,
    );
  }
  if (longLines) {
    notices.push(
      `[Some lines exceeded ${LIMITS.READ_MAX_CHARS_PER_LINE.toLocaleString()} characters and were truncated.]`,
    );
  }
  if (byTotal) {
    notices.push(
      "[Use Read with offset and limit on the full file to read it in smaller sections.]",
    );
  }
  if (notices.length) notices.push(`[Full file: ${fullPath}]`);
  return notices.length ? `${result}\n\n${notices.join("\n\n")}` : result;
}

/**
 * Last-edited time (ms) for each direct child of `dir`. A directory's time is
 * its most recent edit anywhere beneath it. Committed paths use their latest
 * commit time, because checkouts reset mtimes; uncommitted or untracked paths
 * (and memory outside git) use filesystem mtime.
 */
function lastEditedByChild(dir: string, names: string[]): Map<string, number> {
  const edited = new Map<string, number>();
  const bump = (name: string, time: number) => {
    if (time > (edited.get(name) ?? 0)) edited.set(name, time);
  };
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const walkMtime = (path: string, name: string) => {
    try {
      const stat = statSync(path);
      if (stat.isFile()) return bump(name, stat.mtimeMs);
      if (!stat.isDirectory()) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!isHidden(entry.name)) walkMtime(join(path, entry.name), name);
      }
    } catch {
      // Unreadable entries sort last.
    }
  };

  let dirty: string[];
  try {
    // Newest commit first; the first time seen per child is its latest commit.
    let commitTime = 0;
    for (const line of git([
      "log",
      "--format=%x00%ct",
      "--name-only",
      "--relative",
      "--",
      ".",
    ]).split("\n")) {
      const child = line.split("/")[0] ?? line;
      if (line.startsWith("\0")) commitTime = Number(line.slice(1)) * 1000;
      else if (line && !edited.has(child)) edited.set(child, commitTime);
    }
    const prefix = git(["rev-parse", "--show-prefix"]).trim();
    dirty = git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ])
      .split("\0")
      .filter((record) => record.length > 3)
      .map((record) => record.slice(3))
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  } catch {
    edited.clear();
    dirty = names;
  }
  for (const path of dirty)
    walkMtime(join(dir, path), path.split("/")[0] ?? path);
  return edited;
}

function renderDirectory(
  memoryDir: string,
  relPath: string,
  fullPath: string,
): string {
  const entries = readdirSync(fullPath, { withFileTypes: true }).filter(
    (entry) =>
      !isHidden(entry.name) &&
      (entry.isDirectory() || (entry.isFile() && entry.name !== INDEX)),
  );
  const edited = lastEditedByChild(
    fullPath,
    entries.map((entry) => entry.name),
  );
  // Most recently edited first (files and subdirectories together), then by name.
  const shown = entries
    .sort(
      (a, b) =>
        (edited.get(b.name) ?? 0) - (edited.get(a.name) ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, LIMITS.MEMORY_MAX_ENTRIES);

  const fileLines = shown
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const description =
        extname(entry.name) === ".md"
          ? readDescription(join(fullPath, entry.name))
          : undefined;
      return `  <file${descriptionAttr(description)}>${escapeXmlText(`${relPath}/${entry.name}`)}</file>`;
    });
  const dirLines = shown
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const description = readIndexDescription(
        join(fullPath, entry.name, INDEX),
      );
      return `  <directory${descriptionAttr(description)}>${escapeXmlText(`${relPath}/${entry.name}`)}</directory>`;
    });

  const tail = [
    `Memory directory: ${memoryDir}`,
    "Paths in this memory are relative to the memory directory.",
  ];
  if (fileLines.length) {
    tail.push("", "<memory_files>", ...fileLines, "</memory_files>");
  }
  if (dirLines.length) {
    tail.push("", "<deferred-memory>", ...dirLines, "</deferred-memory>");
  }
  if (entries.length > LIMITS.MEMORY_MAX_ENTRIES) {
    tail.push(
      `[Output truncated: showing ${LIMITS.MEMORY_MAX_ENTRIES.toLocaleString()} of ${entries.length.toLocaleString()} entries.]`,
      `[Full listing: ${fullPath}]`,
    );
  }
  const tailText = tail.join("\n");

  const indexPath = join(fullPath, INDEX);
  const open = `<memory_content path="${escapeXmlText(relPath).replace(/"/g, "&quot;")}">`;
  const close = "</memory_content>";
  let head: string;
  if (existsSync(indexPath)) {
    // Keep the whole return within Read's budget so the listing survives the tool-return backstop.
    const budget = Math.max(
      2_000,
      LIMITS.READ_OUTPUT_CHARS -
        tailText.length -
        open.length -
        close.length -
        16,
    );
    head = clampContent(
      readFileSync(indexPath, "utf8").trimEnd(),
      indexPath,
      budget,
    );
  } else {
    head = `<note>No ${INDEX} index in this directory.</note>`;
  }
  return `${open}\n${head}\n\n${tailText}\n${close}`;
}

function renderFile(relPath: string, fullPath: string): string {
  const content = readFileSync(fullPath, "utf8").trimEnd();
  const open = `<memory_content path="${escapeXmlText(relPath).replace(/"/g, "&quot;")}"${descriptionAttr(readDescription(fullPath))}>`;
  const close = "</memory_content>";
  return `${open}\n${clampContent(content, fullPath, LIMITS.READ_OUTPUT_CHARS - open.length - close.length - 2)}\n${close}`;
}

export async function memory(args: MemoryArgs): Promise<{ content: string }> {
  validateRequiredParams(args, ["path"], "Memory");
  const memoryDir = resolveMemoryToolDirectory();
  if (!memoryDir) {
    throw new Error(
      "Memory() is only available for agents with a MemFS v2 memory directory.",
    );
  }

  const raw = String(args.path).trim();
  const relPath = raw
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!relPath || relPath === "." || relPath === INDEX) {
    throw new Error(
      "The memory root is already in your context. Pass a directory from <deferred-memory>.",
    );
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(
      'Paths are relative to the memory directory, e.g. "projects".',
    );
  }
  const segments = relPath.split("/");
  if (segments.some((s) => s === ".." || s === "" || isHidden(s))) {
    throw new Error(`Invalid memory path: ${raw}`);
  }
  if (segments[0] === "skills") {
    throw new Error(
      `skills/ is reserved for skills. Use Skill("${segments[1] ?? "<name>"}").`,
    );
  }

  const fullPath = join(memoryDir, ...segments);
  if (!existsSync(fullPath)) {
    // Suggest the root-relative path for legacy directory-relative links.
    const candidates =
      !relPath.endsWith(".md") && existsSync(`${fullPath}.md`)
        ? [`${relPath}.md`]
        : findByBasename(memoryDir, segments[segments.length - 1] ?? relPath);
    const hint = candidates.length
      ? ` Did you mean ${candidates.join(" or ")}? Paths are relative to the memory directory.`
      : "";
    throw new Error(`No memory at ${relPath}.${hint}`);
  }
  const realRoot = realpathSync(memoryDir);
  const realTarget = realpathSync(fullPath);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(`Invalid memory path: ${raw}`);
  }

  const stat = statSync(fullPath);
  if (segments.length === 1 && stat.isFile()) {
    throw new Error(
      `${relPath} is root core memory and is already in your context.`,
    );
  }
  if (stat.isDirectory()) {
    return { content: renderDirectory(memoryDir, relPath, fullPath) };
  }
  if (!stat.isFile()) {
    throw new Error(`Not a memory file or directory: ${relPath}`);
  }
  if (readFileSync(fullPath).subarray(0, 8_000).includes(0)) {
    throw new Error(
      `${relPath} is not a text file. Use Read on ${fullPath} instead.`,
    );
  }
  return { content: renderFile(relPath, fullPath) };
}
