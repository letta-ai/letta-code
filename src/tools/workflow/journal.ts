/**
 * Run persistence: every workflow run gets a directory holding the script it
 * ran, its args, and a JSONL journal with one line per completed subagent
 * call. The journal is a debugging record (what each agent actually
 * returned); nothing replays from it.
 *
 * Everything here holds prompts, responses, and script source, so files are
 * created owner-only regardless of the process umask.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentOutcome } from "./types.ts";

export type JournalEntry =
  | {
      callIndex: number;
      label: string;
      prompt: string;
      outcome: SubagentOutcome;
    }
  | {
      kind: "decision";
      model: string;
      cost?: number;
      calibrated: boolean;
      valid: boolean;
      totalTokens: number;
    };

export function defaultExecutionsDir(): string {
  return join(homedir(), ".letta", "workflows", "executions");
}

export function newExecutionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 12; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `wf-${suffix}`;
}

/** Create the run directory and persist the script (and args) it will run. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function createExecutionDir(
  executionsDir: string,
  executionId: string,
  script: string,
  args: unknown,
): { executionDir: string; scriptPath: string; journalPath: string } {
  const executionDir = join(executionsDir, executionId);
  mkdirSync(executionDir, { recursive: true, mode: DIR_MODE });
  const scriptPath = join(executionDir, "script.js");
  writeFileSync(scriptPath, script, { mode: FILE_MODE });
  if (args !== undefined) {
    writeFileSync(
      join(executionDir, "args.json"),
      JSON.stringify(args, null, 2),
      { mode: FILE_MODE },
    );
  }
  return {
    executionDir,
    scriptPath,
    journalPath: join(executionDir, "journal.jsonl"),
  };
}

export function appendJournalEntry(
  journalPath: string,
  entry: JournalEntry,
): void {
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, {
    mode: FILE_MODE,
  });
}
