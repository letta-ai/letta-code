import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { GrepInFilesMatch } from "@/types/protocol_v2";

function getRipgrepPath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    return rgPackage.rgPath;
  } catch (_error) {
    return "rg";
  }
}

const rgPath = getRipgrepPath();

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

export interface RunGrepInFilesArgs {
  searchRoot: string;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  glob?: string;
  maxResults: number;
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
  rgArgs.push("-e", query, "--", searchRoot);

  const stdout = await runRipgrep(rgArgs);

  return parseRipgrepJson(stdout, {
    searchRoot,
    maxResults,
    contextLines,
  });
}

function runRipgrep(rgArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      rgPath,
      rgArgs,
      {
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, _stderr) => {
        if (error && error.code !== 1) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("grep_in_files timed out after 30s"));
    }, 30_000);
    child.on("exit", () => clearTimeout(timer));
  });
}

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

  let currentFile: string | null = null;
  const ringBefore: LineBuf[] = [];
  const pendingAfters: Array<{
    match: GrepInFilesMatch;
    needed: number;
  }> = [];

  const flushPending = () => {
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

      const text = stripTrailingNewline(m.data.lines.text);

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

function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function toRelative(absPath: string, root: string): string {
  const rel = path.relative(root, absPath);
  return rel || path.basename(absPath);
}
