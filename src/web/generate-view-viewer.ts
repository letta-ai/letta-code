/**
 * Universal artifact viewer.
 *
 * Renders a single file (image, PDF, SVG, Markdown, CSV, HTML, or code/text)
 * into a self-contained HTML viewer, writes it to ~/.letta/viewers/, and opens
 * it in the user's browser. Mirrors the diff/memory viewer pattern.
 *
 * With no target path, auto-selects the most recently modified previewable
 * file in the current git worktree (falling back to a shallow cwd scan).
 */

import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import viewViewerTemplate from "./view-viewer-template.txt";

const execFile = promisify(execFileCb);

const VIEWERS_DIR = join(homedir(), ".letta", "viewers");
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

// Caps to keep generated HTML reasonable.
const MAX_BINARY_BYTES = 50 * 1024 * 1024; // images / pdf
const MAX_TEXT_BYTES = 5 * 1024 * 1024; // markdown / code / csv / html

export type ViewKind =
  | "image"
  | "pdf"
  | "html"
  | "markdown"
  | "csv"
  | "code"
  | "text";

export type ViewViewerResult = {
  filePath: string; // path of the generated viewer HTML
  targetPath: string; // path of the file that was rendered
  kind: ViewKind;
  opened: boolean;
};

type ViewPayload = {
  name: string;
  path: string;
  kind: ViewKind;
  lang?: string;
  mime?: string;
  sizeBytes: number;
  sizeLabel: string;
  generatedAt: string;
  dataUri?: string;
  text?: string;
  delimiter?: string;
  truncated?: boolean;
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "css",
  "scss",
  "less",
  "lua",
  "r",
  "pl",
  "dart",
  "scala",
  "clj",
  "ex",
  "exs",
  "vue",
  "svelte",
  "diff",
  "patch",
  "gitignore",
  "dockerfile",
  "makefile",
]);

const PREVIEWABLE_EXTENSIONS = new Set<string>([
  ...Object.keys(IMAGE_MIME),
  "pdf",
  "html",
  "htm",
  "md",
  "markdown",
  "csv",
  "tsv",
  ...TEXT_EXTENSIONS,
]);

function getExtension(filePath: string): string {
  const ext = extname(filePath).replace(/^\./, "").toLowerCase();
  if (ext) return ext;
  // Handle extensionless well-known files.
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base === "makefile") return base;
  return "";
}

function classifyKind(ext: string): ViewKind | null {
  if (ext in IMAGE_MIME) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (TEXT_EXTENSIONS.has(ext)) return "code";
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function resolveTargetPath(targetPath: string): string {
  return isAbsolute(targetPath)
    ? targetPath
    : resolve(process.cwd(), targetPath);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout?.toString() ?? "";
  } catch {
    return "";
  }
}

function newestPreviewable(
  candidates: string[],
): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  for (const candidate of candidates) {
    const ext = getExtension(candidate);
    if (!PREVIEWABLE_EXTENSIONS.has(ext)) continue;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      const mtime = stat.mtimeMs;
      if (!best || mtime > best.mtime) best = { path: candidate, mtime };
    } catch {
      // ignore unreadable entries
    }
  }
  return best;
}

/**
 * Pick the most recently modified previewable file. Prefers git-tracked and
 * untracked files (fast + scoped), falling back to a shallow cwd scan.
 */
async function autoSelectTarget(cwd: string): Promise<string | null> {
  const topLevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (topLevel) {
    const [tracked, untracked] = await Promise.all([
      runGit(topLevel, ["ls-files", "-z"]),
      runGit(topLevel, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const rel = [...tracked.split("\0"), ...untracked.split("\0")]
      .map((entry) => entry.trim())
      .filter(Boolean);
    const abs = rel.map((entry) => join(topLevel, entry));
    const best = newestPreviewable(abs);
    if (best) return best.path;
  }

  // Fallback: shallow scan of cwd.
  try {
    const entries = readdirSync(cwd).map((name) => join(cwd, name));
    const best = newestPreviewable(entries);
    if (best) return best.path;
  } catch {
    // ignore
  }
  return null;
}

function buildPayload(targetPath: string): ViewPayload {
  const stat = statSync(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${targetPath}`);
  }
  const ext = getExtension(targetPath);
  const kind = classifyKind(ext);
  if (!kind) {
    throw new Error(
      `Unsupported file type${ext ? ` (.${ext})` : ""}: ${targetPath}`,
    );
  }

  const name = targetPath.split(/[\\/]/).pop() ?? targetPath;
  const base: ViewPayload = {
    name,
    path: targetPath,
    kind,
    sizeBytes: stat.size,
    sizeLabel: formatBytes(stat.size),
    generatedAt: new Date().toISOString(),
  };

  if (kind === "image" || kind === "pdf") {
    if (stat.size > MAX_BINARY_BYTES) {
      throw new Error(
        `File too large to preview (${formatBytes(stat.size)}, max ${formatBytes(MAX_BINARY_BYTES)}).`,
      );
    }
    const mime = kind === "pdf" ? "application/pdf" : IMAGE_MIME[ext];
    const b64 = readFileSync(targetPath).toString("base64");
    return { ...base, mime, dataUri: `data:${mime};base64,${b64}` };
  }

  // Text-based kinds: markdown / csv / html / code.
  const raw = readFileSync(targetPath);
  const truncated = raw.length > MAX_TEXT_BYTES;
  const text = (truncated ? raw.subarray(0, MAX_TEXT_BYTES) : raw).toString(
    "utf8",
  );
  const payload: ViewPayload = { ...base, lang: ext, text, truncated };
  if (kind === "csv") payload.delimiter = ext === "tsv" ? "\t" : ",";
  return payload;
}

function shouldSkipOpen(): boolean {
  return (
    Boolean(process.env.TMUX) ||
    Boolean(process.env.SSH_CONNECTION) ||
    Boolean(process.env.SSH_TTY)
  );
}

export async function generateAndOpenViewViewer(
  targetPath?: string,
): Promise<ViewViewerResult> {
  const cwd = process.cwd();
  let resolved: string;
  if (targetPath?.trim()) {
    resolved = resolveTargetPath(targetPath.trim());
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
  } else {
    const auto = await autoSelectTarget(cwd);
    if (!auto) {
      throw new Error("No previewable file found. Pass a path: /view <file>");
    }
    resolved = auto;
  }

  const payload = buildPayload(resolved);

  const jsonPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = viewViewerTemplate.replace(
    "<!--LETTA_VIEW_DATA_PLACEHOLDER-->",
    () => jsonPayload,
  );

  if (!existsSync(VIEWERS_DIR)) {
    mkdirSync(VIEWERS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(VIEWERS_DIR, 0o700);
  } catch {}

  const filePath = join(
    VIEWERS_DIR,
    `view-${encodeURIComponent(resolved)}.html`,
  );
  writeFileSync(filePath, html);
  chmodSync(filePath, 0o600);

  const skipOpen = shouldSkipOpen();
  if (!skipOpen) {
    try {
      const { default: openUrl } = await import("open");
      await openUrl(filePath, { wait: false });
    } catch {
      throw new Error(`Could not open browser. Run: open ${filePath}`);
    }
  }

  return {
    filePath,
    targetPath: resolved,
    kind: payload.kind,
    opened: !skipOpen,
  };
}
