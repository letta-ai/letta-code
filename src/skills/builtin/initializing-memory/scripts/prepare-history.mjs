#!/usr/bin/env node
// Turn a `letta trajectories export` directory into Workflow-ready history
// cohorts: render every session to plain text (Workflow subagents only have
// Read/Grep/Glob), group sessions into size-bounded cohorts per project, and
// record a coverage ledger of everything that was excluded and why.
//
// Usage:
//   node prepare-history.mjs --export <dir> --out <dir>
//     [--max-bytes 200000] [--max-sessions 20] [--letta "letta"]
//
// Writes <out>/rendered/<source>/<session>.txt, <out>/cohorts.json
// ({ historyCohorts }) and <out>/ledger.json, and prints a summary.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  'Usage: prepare-history.mjs --export <dir> --out <dir> [--max-bytes N] [--max-sessions N] [--letta "letta"]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    fail(`--${name} must be a positive integer`);
  return n;
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session"
  );
}

function render(lettaCmd, exportDir, file) {
  const [bin, ...prefix] = lettaCmd;
  const result = spawnSync(
    bin,
    [...prefix, "trajectories", "view", file, "--out", exportDir, "--tools"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    return { error: (result.stderr || `exit ${result.status}`).trim() };
  }
  return { text: result.stdout };
}

function buildCohorts(sessions, maxBytes, maxSessions) {
  const byProject = new Map();
  for (const session of sessions) {
    const key = session.project ?? "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(session);
  }

  const cohorts = [];
  const usedIds = new Set();
  for (const [project, list] of byProject) {
    list.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    let current = [];
    let bytes = 0;
    const flush = () => {
      if (current.length === 0) return;
      const base = `${slug(project ? basename(project) : "unknown-project")}-${(current[0].startedAt ?? "undated").slice(0, 10)}`;
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      usedIds.add(id);
      cohorts.push({
        id,
        repo: project && existsSync(project) ? project : null,
        sessions: current,
      });
      current = [];
      bytes = 0;
    };
    for (const session of list) {
      if (
        current.length > 0 &&
        (bytes + session.renderedBytes > maxBytes ||
          current.length >= maxSessions)
      ) {
        flush();
      }
      current.push(session);
      bytes += session.renderedBytes;
    }
    flush();
  }

  return cohorts.map((cohort) => ({
    ...cohort,
    sessions: cohort.sessions.map(({ renderedBytes: _bytes, ...rest }) => rest),
  }));
}

const { values } = parseArgs({
  options: {
    export: { type: "string" },
    out: { type: "string" },
    "max-bytes": { type: "string", default: "200000" },
    "max-sessions": { type: "string", default: "20" },
    letta: { type: "string", default: "letta" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.export || !values.out) fail(USAGE);

const exportDir = resolve(values.export);
const outDir = resolve(values.out);
const maxBytes = positiveInt(values["max-bytes"], "max-bytes");
const maxSessions = positiveInt(values["max-sessions"], "max-sessions");
const lettaCmd = values.letta.trim().split(/\s+/);

const manifestPath = join(exportDir, "manifest.json");
if (!existsSync(manifestPath)) {
  fail(
    `No manifest at ${manifestPath}. Run: letta trajectories export --out ${exportDir}`,
  );
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const excluded = [];
const rendered = [];
for (const entry of manifest.sessions ?? []) {
  const ref = {
    sessionId: entry.sessionId,
    source: entry.source,
    file: entry.file,
  };
  if (!entry.userMessages) {
    excluded.push({ ...ref, reason: "no user messages" });
    continue;
  }
  const result = render(lettaCmd, exportDir, entry.file);
  if (result.error) {
    excluded.push({ ...ref, reason: `render failed: ${result.error}` });
    continue;
  }
  const path = join(outDir, "rendered", entry.file.replace(/\.json$/, ".txt"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.text);
  rendered.push({
    sessionId: entry.sessionId,
    path,
    source: entry.source,
    project: entry.project ?? null,
    startedAt: entry.startedAt ?? null,
    userMessages: entry.userMessages,
    renderedBytes: statSync(path).size,
  });
}

const historyCohorts = buildCohorts(rendered, maxBytes, maxSessions);
const ledger = {
  exportDir,
  manifestSessions: (manifest.sessions ?? []).length,
  exportErrors: manifest.errors ?? [],
  assigned: rendered.length,
  excluded,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "cohorts.json"),
  `${JSON.stringify({ historyCohorts }, null, 2)}\n`,
);
writeFileSync(
  join(outDir, "ledger.json"),
  `${JSON.stringify(ledger, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      cohorts: historyCohorts.length,
      manifestSessions: ledger.manifestSessions,
      assigned: ledger.assigned,
      excluded: excluded.length,
      exportErrors: ledger.exportErrors.length,
      cohortsFile: join(outDir, "cohorts.json"),
      ledgerFile: join(outDir, "ledger.json"),
    },
    null,
    2,
  ),
);
