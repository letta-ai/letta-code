/**
 * Ripgrep-backed content search for the `grep_in_files` listener
 * command. Uses `--json` so we get exact line numbers and match
 * column ranges without re-parsing ripgrep's human output, then
 * reshapes the stream into flat `GrepInFilesMatch` records (one per
 * hit, with optional before/after context).
 *
 * This is intentionally a standalone helper instead of reusing the
 * tool-call `grep()` wrapper: we need match-level structure (line,
 * column, text, context lines), not a text blob for an LLM.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { GrepInFilesMatch } from "../../types/protocol_v2";

// ── Ripgrep binary resolution ──────────────────────────────────────

function getRipgrepPath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    return rgPackage.rgPath;
  } catch (_error) {
    // Fallback to a system ripgrep in PATH.
    return "rg";
  }
}

const rgPath = getRipgrepPath();

// ── Ripgrep JSON stream shapes ─────────────────────────────────────
//
// Docs: https://docs.rs/grep-printer/latest/grep_printer/struct.JSON.html
//
// We only need three event kinds: `match`, `context`, and `end`. The
// others (`summary`, `begin`) don't carry data we care about.

interface RipgrepText {
  text: string;
}

interface RipgrepSubmatch {
  match: RipgrepText;
  start: number;
  end: number;
}

interface RipgrepMatchEvent {
  type: "match";
  data: {
    path: RipgrepText;
    lines: RipgrepText;
    line_number: number;
    absolute_offset: number;
    submatches: RipgrepSubmatch[];
  };
}

interface RipgrepContextEvent {
  type: "context";
  data: {
    path: RipgrepText;
    lines: RipgrepText;
    line_number: number;
  };
}

interface RipgrepEndEvent {
  type: "end";
  data: { path: RipgrepText };
}

type RipgrepEvent =
  | RipgrepMatchEvent
  | RipgrepContextEvent
  | RipgrepEndEvent
  | { type: string; data?: unknown };

// ── Public API ─────────────────────────────────────────────────────

export interface RunGrepInFilesArgs {
  /** Absolute directory to search under. */
  searchRoot: string;
  /** Raw query string — literal unless isRegex is true. */
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Optional ripgrep --glob filter. Empty string is ignored. */
  glob?: string;
  /** Max match rows returned to the client. */
  maxResults: number;
  /** Lines before/after each match to include. */
  contextLines: number;
}

export interface RunGrepInFilesResult {
  matches: GrepInFilesMatch[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}

export async function runGrepInFiles(
  args: RunGrepInFilesArgs,
): Promise<RunGrepInFilesResult> {
  const {
    searchRoot,
    query,
    isRegex,
    caseSensitive,
    wholeWord,
    glob,
    maxResults,
    contextLines,
  } = args;

  // Empty queries: nothing to search, skip the subprocess entirely.
  if (!query) {
    return {
      matches: [],
      totalMatches: 0,
      totalFiles: 0,
      truncated: false,
    };
  }

  const rgArgs: string[] = ["--json"];
  if (!isRegex) rgArgs.push("-F");
  if (!caseSensitive) rgArgs.push("-i");
  if (wholeWord) rgArgs.push("-w");
  if (contextLines > 0) {
    rgArgs.push("-C", contextLines.toString());
  }
  if (glob?.trim()) {
    rgArgs.push("--glob", glob.trim());
  }
  // Respect .gitignore + skip hidden files/dirs by default. These are
  // ripgrep's defaults but making it explicit keeps the behavior
  // stable if @vscode/ripgrep ever changes its build flags.
  rgArgs.push("-e", query, "--", searchRoot);

  const stdout = await runRipgrep(rgArgs);

  return parseRipgrepJson(stdout, {
    searchRoot,
    maxResults,
    contextLines,
  });
}

// ── Execution ──────────────────────────────────────────────────────

function runRipgrep(rgArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      rgPath,
      rgArgs,
      {
        // JSON mode emits one object per line; matches can be long.
        // 50MB covers even pathological repos before we truncate.
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, _stderr) => {
        // ripgrep exits 1 when there are no matches — that's not an
        // error, it's an empty result set.
        if (error && error.code !== 1) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );

    // Defensive: if the process never emits, reject so the caller's
    // wrapper (runDetachedListenerTask) can clean up. 30s is well above
    // a typical content search against a monorepo.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("grep_in_files timed out after 30s"));
    }, 30_000);
    child.on("exit", () => clearTimeout(timer));
  });
}

// ── Parsing ────────────────────────────────────────────────────────

interface ParseOpts {
  searchRoot: string;
  maxResults: number;
  contextLines: number;
}

interface LineBuf {
  lineNumber: number;
  text: string;
}

function parseRipgrepJson(
  stdout: string,
  opts: ParseOpts,
): RunGrepInFilesResult {
  const { searchRoot, maxResults, contextLines } = opts;

  const matches: GrepInFilesMatch[] = [];
  const filesHit = new Set<string>();
  let totalMatches = 0;

  // Per-file ring of context lines (capped at contextLines * 2 to
  // handle both before/after efficiently).
  let currentFile: string | null = null;
  const ringBefore: LineBuf[] = [];
  // Pending matches waiting for their `after` context to fill.
  const pendingAfters: Array<{
    match: GrepInFilesMatch;
    needed: number;
  }> = [];

  const flushPending = () => {
    // Anything still pending at file end gets whatever `after` lines
    // it managed to collect — no need to pad.
    pendingAfters.length = 0;
  };

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    let evt: RipgrepEvent;
    try {
      evt = JSON.parse(line) as RipgrepEvent;
    } catch {
      continue;
    }

    if (evt.type === "match") {
      const m = evt as RipgrepMatchEvent;
      const filePath = m.data.path.text;
      if (currentFile !== filePath) {
        flushPending();
        ringBefore.length = 0;
        currentFile = filePath;
      }
      const relPath = toRelative(filePath, searchRoot);
      filesHit.add(relPath);
      totalMatches += 1;

      const first = m.data.submatches[0];
      if (!first) continue;

      // ripgrep lines include a trailing newline — strip it.
      const text = stripTrailingNewline(m.data.lines.text);

      // Byte offsets from ripgrep are into the line text WITH the
      // newline. For ASCII they match character columns; for UTF-8 we
      // approximate by converting the prefix to a JS string length.
      const prefix = m.data.lines.text.slice(0, first.start);
      const column = prefix.length + 1;
      const matchLen = first.match.text.length;

      if (matches.length < maxResults) {
        const matchRecord: GrepInFilesMatch = {
          path: relPath,
          line: m.data.line_number,
          column,
          column_end: column + matchLen,
          text,
          before:
            contextLines > 0
              ? ringBefore
                  .slice(-contextLines)
                  .map((b) => stripTrailingNewline(b.text))
              : undefined,
          after: contextLines > 0 ? [] : undefined,
        };
        matches.push(matchRecord);
        if (contextLines > 0) {
          pendingAfters.push({ match: matchRecord, needed: contextLines });
        }
      }
      continue;
    }

    if (evt.type === "context") {
      const c = evt as RipgrepContextEvent;
      const filePath = c.data.path.text;
      if (currentFile !== filePath) {
        flushPending();
        ringBefore.length = 0;
        currentFile = filePath;
      }
      const text = stripTrailingNewline(c.data.lines.text);

      // Feed pending matches first (these are `after` context lines).
      if (pendingAfters.length > 0) {
        for (let i = pendingAfters.length - 1; i >= 0; i -= 1) {
          const p = pendingAfters[i];
          if (!p || !p.match.after) continue;
          p.match.after.push(text);
          p.needed -= 1;
          if (p.needed === 0) {
            pendingAfters.splice(i, 1);
          }
        }
      }

      // Always also feed the ring for future matches' `before`.
      if (contextLines > 0) {
        ringBefore.push({
          lineNumber: c.data.line_number,
          text: c.data.lines.text,
        });
        if (ringBefore.length > contextLines) {
          ringBefore.shift();
        }
      }
      continue;
    }

    if (evt.type === "end") {
      flushPending();
      ringBefore.length = 0;
      currentFile = null;
    }
  }

  return {
    matches,
    totalMatches,
    totalFiles: filesHit.size,
    truncated: totalMatches > matches.length,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function toRelative(absPath: string, root: string): string {
  const rel = path.relative(root, absPath);
  // ripgrep sometimes returns paths as-provided on the CLI (i.e.
  // already relative). `path.relative` handles both cases.
  return rel || path.basename(absPath);
}
