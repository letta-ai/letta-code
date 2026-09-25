#!/usr/bin/env node
// Account for every exported session after the analysis Workflow ran.
// Compares the cohorts and ledger written by prepare-history.mjs against the
// Workflow journal(s): a session counts as analyzed only when some history
// subagent returned JSON whose `sessionsRead` array names its sessionId.
//
// Usage:
//   node history-coverage.mjs --prepared <dir> --journal <journal.jsonl>
//     [--journal <journal.jsonl> ...] [--retry-out <file>] [--retry-size 5]
//
// Prints a coverage report. With --retry-out, writes { historyCohorts } with
// the unread sessions split into smaller cohorts for a follow-up Workflow run.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "Usage: history-coverage.mjs --prepared <dir> --journal <journal.jsonl> [--journal ...] [--retry-out <file>] [--retry-size N]";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  if (!existsSync(path))
    fail(`Missing ${path}; run prepare-history.mjs first.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSessionsRead(journalPath) {
  if (!existsSync(journalPath)) fail(`Missing journal ${journalPath}`);
  const read = new Set();
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const value = entry?.outcome?.failed ? null : entry?.outcome?.value;
    if (value && Array.isArray(value.sessionsRead)) {
      for (const id of value.sessionsRead) {
        if (typeof id === "string") read.add(id);
      }
    }
  }
  return read;
}

const { values } = parseArgs({
  options: {
    prepared: { type: "string" },
    journal: { type: "string", multiple: true },
    "retry-out": { type: "string" },
    "retry-size": { type: "string", default: "5" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.prepared || !values.journal?.length) fail(USAGE);
const retrySize = Number(values["retry-size"]);
if (!Number.isSafeInteger(retrySize) || retrySize < 1) {
  fail("--retry-size must be a positive integer");
}

const preparedDir = resolve(values.prepared);
const { historyCohorts } = readJson(join(preparedDir, "cohorts.json"));
const ledger = readJson(join(preparedDir, "ledger.json"));

const read = new Set();
for (const journal of values.journal) {
  for (const id of readSessionsRead(resolve(journal))) read.add(id);
}

const unread = [];
let analyzed = 0;
for (const cohort of historyCohorts) {
  const missing = cohort.sessions.filter((s) => !read.has(s.sessionId));
  analyzed += cohort.sessions.length - missing.length;
  if (missing.length)
    unread.push({ cohort: cohort.id, repo: cohort.repo, sessions: missing });
}

const unreadCount = unread.reduce((n, c) => n + c.sessions.length, 0);
const inCohorts = analyzed + unreadCount;
// Sessions the ledger assigned but that were later dropped from cohorts.json
// (for example deprioritized by hand) were never sent to the Workflow.
const droppedFromCohorts = Math.max(0, ledger.assigned - inCohorts);
const report = {
  manifestSessions: ledger.manifestSessions,
  exportErrors: ledger.exportErrors.length,
  excluded: ledger.excluded.length,
  droppedFromCohorts,
  analyzed,
  unread: unread.map((c) => ({
    cohort: c.cohort,
    sessionIds: c.sessions.map((s) => s.sessionId),
  })),
  allAssignedRead: unreadCount === 0 && droppedFromCohorts === 0,
};

if (values["retry-out"]) {
  const retryCohorts = [];
  for (const cohort of unread) {
    for (let i = 0; i < cohort.sessions.length; i += retrySize) {
      retryCohorts.push({
        id: `${cohort.cohort}-retry-${i / retrySize + 1}`,
        repo: cohort.repo,
        sessions: cohort.sessions.slice(i, i + retrySize),
      });
    }
  }
  const retryPath = resolve(values["retry-out"]);
  writeFileSync(
    retryPath,
    `${JSON.stringify({ historyCohorts: retryCohorts }, null, 2)}\n`,
  );
  report.retryFile = retryPath;
  report.retryCohorts = retryCohorts.length;
}

console.log(JSON.stringify(report, null, 2));
