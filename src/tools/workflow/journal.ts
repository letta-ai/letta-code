/**
 * Run persistence: every workflow run gets a directory holding the script it
 * ran and a JSONL journal of each subagent call's outcome. Resume replays
 * journaled results keyed by (cacheKey, occurrence), so unchanged agent()
 * calls return instantly and only edited or new calls run live.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentOutcome } from "./types.ts";

export interface JournalEntry {
  kind: "agent";
  cacheKey: string;
  occurrence: number;
  label: string;
  prompt: string;
  outcome: SubagentOutcome;
}

export function defaultRunsDir(): string {
  return join(homedir(), ".letta", "workflows", "runs");
}

export function newRunId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 12; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `wf-${suffix}`;
}

export class RunJournal {
  readonly runDir: string;
  private readonly journalPath: string;
  private readonly cache = new Map<string, SubagentOutcome[]>();

  constructor(runsDir: string, runId: string) {
    this.runDir = join(runsDir, runId);
    mkdirSync(this.runDir, { recursive: true });
    this.journalPath = join(this.runDir, "journal.jsonl");
  }

  persistScript(script: string, args: unknown): void {
    writeFileSync(join(this.runDir, "script.js"), script);
    if (args !== undefined) {
      writeFileSync(
        join(this.runDir, "args.json"),
        JSON.stringify(args, null, 2),
      );
    }
  }

  record(entry: JournalEntry): void {
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`);
  }

  /** Load a prior run's journal into this journal's replay cache. */
  loadReplayCache(runsDir: string, priorRunId: string): number {
    const priorPath = join(runsDir, priorRunId, "journal.jsonl");
    let raw: string;
    try {
      raw = readFileSync(priorPath, "utf8");
    } catch {
      throw new Error(
        `No journal found for run "${priorRunId}" at ${priorPath}.`,
      );
    }
    let loaded = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        continue;
      }
      if (entry.kind !== "agent" || entry.outcome.failed) continue;
      const bucket = this.cache.get(entry.cacheKey) ?? [];
      bucket[entry.occurrence] = entry.outcome;
      this.cache.set(entry.cacheKey, bucket);
      loaded++;
    }
    return loaded;
  }

  /** Return the cached outcome for this exact call, if the prior run had it. */
  replay(cacheKey: string, occurrence: number): SubagentOutcome | undefined {
    return this.cache.get(cacheKey)?.[occurrence];
  }
}
