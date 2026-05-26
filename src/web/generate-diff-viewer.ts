/**
 * Browser diff viewer for git worktrees.
 *
 * Collects a git diff for the current worktree, renders each file with
 * @pierre/diffs, writes a self-contained HTML file to ~/.letta/viewers/, and
 * opens it in the user's browser.
 */

import { execFile as execFileCb } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import diffViewerTemplate from "./diff-viewer-template.txt";

const execFile = promisify(execFileCb);

const VIEWERS_DIR = join(homedir(), ".letta", "viewers");
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
const MAX_RENDERED_FILES = 100;
const DIFF_UNSAFE_CSS = `
:host {
  --diffs-addition-color-override: #15803d;
  --diffs-deletion-color-override: #b91c1c;
  --diffs-bg-addition-override: light-dark(#d1fadf, rgba(22, 163, 74, 0.26));
  --diffs-bg-deletion-override: light-dark(#ffe0e0, rgba(220, 38, 38, 0.3));
  --diffs-bg-addition-emphasis-override: light-dark(#86efac, rgba(34, 197, 94, 0.48));
  --diffs-bg-deletion-emphasis-override: light-dark(#fca5a5, rgba(248, 113, 113, 0.52));
  --diffs-bg-addition-number-override: light-dark(#bbf7d0, rgba(22, 163, 74, 0.38));
  --diffs-bg-deletion-number-override: light-dark(#fecaca, rgba(220, 38, 38, 0.42));
  --diffs-fg-number-addition-override: light-dark(#166534, #86efac);
  --diffs-fg-number-deletion-override: light-dark(#991b1b, #fca5a5);
}

[data-line-type="change-addition"] {
  --diffs-line-bg: light-dark(#d1fadf, rgba(22, 163, 74, 0.26)) !important;
  background: light-dark(#d1fadf, rgba(22, 163, 74, 0.26)) !important;
}

[data-line-type="change-deletion"] {
  --diffs-line-bg: light-dark(#ffe0e0, rgba(220, 38, 38, 0.3)) !important;
  background: light-dark(#ffe0e0, rgba(220, 38, 38, 0.3)) !important;
}

[data-additions] [data-line-type="change-addition"] {
  box-shadow: inset 3px 0 0 #16a34a;
}

[data-deletions] [data-line-type="change-deletion"] {
  box-shadow: inset 3px 0 0 #dc2626;
}

[data-line-type="change-addition"] span {
  background-color: light-dark(rgba(22, 163, 74, 0.16), rgba(34, 197, 94, 0.22));
}

[data-line-type="change-deletion"] span {
  background-color: light-dark(rgba(220, 38, 38, 0.15), rgba(248, 113, 113, 0.24));
}

[data-line-type="change-addition"] [data-line-number-content]::before {
  content: "+";
  margin-right: 0.45ch;
  color: #16a34a;
}

[data-line-type="change-deletion"] [data-line-number-content]::before {
  content: "−";
  margin-right: 0.45ch;
  color: #dc2626;
}
`;

type GitExecError = Error & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type DiffViewerResult = {
  filePath: string;
  opened: boolean;
  fileCount: number;
};

type DiffViewerFile = {
  name: string;
  prevName?: string;
  type: FileDiffMetadata["type"];
  additions: number;
  deletions: number;
  html: string;
};

type DiffViewerPayload = {
  repoRoot: string;
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
  generatedAt: string;
  insertions: number;
  deletions: number;
  files: DiffViewerFile[];
};

type RenderedDiffFiles = {
  files: DiffViewerFile[];
  insertions: number;
  deletions: number;
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout?.toString() ?? "";
  } catch (error) {
    const gitError = error as GitExecError;
    const stderr = gitError.stderr?.toString().trim();
    throw new Error(stderr || gitError.message);
  }
}

async function runGitOptional(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch {
    return "";
  }
}

function parseNameStatus(diffNameStatus: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diffNameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const renamedPath = parts[2];
      if (renamedPath) paths.add(renamedPath);
      continue;
    }
    const filePath = parts[1];
    if (filePath) paths.add(filePath);
  }
  return paths;
}

function parseNumstat(numstat: string): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    const addedCount = Number(added);
    const removedCount = Number(removed);
    if (Number.isFinite(addedCount)) insertions += addedCount;
    if (Number.isFinite(removedCount)) deletions += removedCount;
  }
  return { insertions, deletions };
}

function getFileKey(file: FileDiffMetadata): string {
  return file.name || file.prevName || "unknown";
}

function getFileLineCounts(file: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionCount;
    deletions += hunk.deletionCount;
  }
  return { additions, deletions };
}

async function listUntrackedFiles(repoRoot: string): Promise<string[]> {
  const output = await runGitOptional(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildUntrackedPatch(repoRoot: string): Promise<string> {
  const files = await listUntrackedFiles(repoRoot);
  const patches: string[] = [];
  for (const file of files) {
    const patch = await runGitOptional(repoRoot, [
      "diff",
      "--binary",
      "--no-index",
      "--",
      "/dev/null",
      file,
    ]);
    if (patch.trim()) patches.push(patch);
  }
  return patches.join("\n");
}

async function collectDiff(cwd: string): Promise<{
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  patch: string;
  changedPaths: Set<string>;
  insertions: number;
  deletions: number;
}> {
  const repoRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const upstream = (
    await runGitOptional(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ])
  ).trim();
  const defaultBranch = (
    await runGitOptional(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
  ).trim();
  const baseRef = upstream || defaultBranch || "HEAD";
  const baseCommit = (
    await runGitOptional(cwd, ["merge-base", baseRef, "HEAD"])
  ).trim();
  const diffBase = baseCommit || baseRef;
  const untrackedPatch = await buildUntrackedPatch(repoRoot);
  const patchParts = await Promise.all([
    runGitOptional(repoRoot, ["diff", "--binary", diffBase]),
    untrackedPatch,
  ]);
  const patch = patchParts.filter(Boolean).join("\n");

  const [diffNames, diffNumstat] = await Promise.all([
    runGitOptional(repoRoot, ["diff", "--name-status", diffBase]),
    runGitOptional(repoRoot, ["diff", "--numstat", diffBase]),
  ]);
  const stats = parseNumstat(diffNumstat);

  return {
    repoRoot,
    baseRef,
    baseCommit: diffBase,
    patch,
    changedPaths: new Set([
      ...parseNameStatus(diffNames),
      ...(await listUntrackedFiles(repoRoot)),
    ]),
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

async function renderDiffFiles(
  patch: string,
  changedPaths: Set<string>,
): Promise<RenderedDiffFiles> {
  if (!patch.trim()) return { files: [], insertions: 0, deletions: 0 };

  const parsed = parsePatchFiles(patch);
  const files = parsed
    .flatMap((entry) => entry.files)
    .slice(0, MAX_RENDERED_FILES);
  const rendered: DiffViewerFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    const lineCounts = getFileLineCounts(file);
    insertions += lineCounts.additions;
    deletions += lineCounts.deletions;
    const result = await preloadFileDiff({
      fileDiff: file,
      options: {
        diffStyle: "split",
        diffIndicators: "bars",
        disableFileHeader: true,
        hunkSeparators: "line-info-basic",
        lineDiffType: "word",
        overflow: "wrap",
        stickyHeader: false,
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        unsafeCSS: DIFF_UNSAFE_CSS,
      },
    });
    rendered.push({
      name: getFileKey(file),
      prevName: file.prevName,
      type: file.type,
      additions: lineCounts.additions,
      deletions: lineCounts.deletions,
      html: result.prerenderedHTML,
    });
  }

  for (const path of changedPaths) {
    if (!rendered.some((file) => file.name === path)) {
      rendered.push({
        name: path,
        type: "change",
        additions: 0,
        deletions: 0,
        html: `<div class="notice">Binary or empty diff omitted for ${escapeHtml(path)}.</div>`,
      });
    }
  }

  return { files: rendered, insertions, deletions };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolveTargetPath(targetPath?: string): string {
  if (!targetPath?.trim()) return process.cwd();
  return isAbsolute(targetPath)
    ? targetPath
    : resolve(process.cwd(), targetPath);
}

function shouldSkipOpen(): boolean {
  return (
    Boolean(process.env.TMUX) ||
    Boolean(process.env.SSH_CONNECTION) ||
    Boolean(process.env.SSH_TTY)
  );
}

export async function generateAndOpenDiffViewer(
  targetPath?: string,
): Promise<DiffViewerResult> {
  const worktreePath = resolveTargetPath(targetPath);
  const collected = await collectDiff(worktreePath);
  const rendered = await renderDiffFiles(
    collected.patch,
    collected.changedPaths,
  );
  const payload: DiffViewerPayload = {
    repoRoot: collected.repoRoot,
    worktreePath,
    baseRef: collected.baseRef,
    baseCommit: collected.baseCommit,
    generatedAt: new Date().toISOString(),
    insertions: rendered.insertions || collected.insertions,
    deletions: rendered.deletions || collected.deletions,
    files: rendered.files,
  };

  const jsonPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = diffViewerTemplate.replace(
    "<!--LETTA_DIFF_DATA_PLACEHOLDER-->",
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
    `diff-${encodeURIComponent(worktreePath)}.html`,
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

  return { filePath, opened: !skipOpen, fileCount: rendered.files.length };
}
